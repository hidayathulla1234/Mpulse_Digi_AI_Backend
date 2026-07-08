require('dotenv').config();
const express = require('express');
const cors = require('cors');
const Razorpay = require('razorpay');
const crypto = require('crypto');
const admin = require('firebase-admin');
const nodemailer = require('nodemailer');
const rateLimit = require('express-rate-limit');
const fetch = require('node-fetch');
const { connectDB, models, getIsConnected } = require('./db');
const { RtcTokenBuilder, RtcRole } = require('agora-token');


const app = express();
connectDB();
const PORT = process.env.PORT || 5000;
app.set('trust proxy', 1);

// ─────────────────────────────────────────────────────────────
// MIDDLEWARE
// ─────────────────────────────────────────────────────────────
const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'http://localhost:3000,http://localhost:5501,http://127.0.0.1:5501,http://localhost:8888,http://localhost:5000,http://127.0.0.1:5000,https://mpulsedigitalai.netlify.app')
  .split(',').map(o => o.trim());

app.use(cors({
  origin(origin, cb) {
    if (
      !origin ||
      allowedOrigins.includes(origin) ||
      allowedOrigins.includes('*') ||
      origin.includes('localhost') ||
      origin.includes('127.0.0.1') ||
      origin.startsWith('http://172.') ||
      origin.startsWith('http://192.168.') ||
      origin.startsWith('http://10.') ||
      origin.startsWith('capacitor://') ||
      origin.startsWith('ionic://')
    ) {
      cb(null, true);
    } else {
      cb(new Error('Not allowed by CORS'));
    }
  }
}));
app.use(express.json());
const path = require('path');
app.use(express.static(path.join(__dirname, '../frontend')));
app.use('/api/', rateLimit({ windowMs: 15 * 60 * 1000, max: 60, message: { error: 'Too many requests. Try again later.' } }));

// ─────────────────────────────────────────────────────────────
// FIREBASE
// ─────────────────────────────────────────────────────────────
let db;
try {
  const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT_JSON
    ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)
    : require('./serviceAccountKey.json');

  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  db = admin.firestore();
  console.log("✅ Firebase initialized successfully");
} catch (e) {
  console.error("⚠️ Firebase could not be initialized:", e.message);
  console.warn("⚠️ Firebase features (saving registrations) will be mocked!");
}

// ─────────────────────────────────────────────────────────────
// RAZORPAY
// ─────────────────────────────────────────────────────────────
let razorpay;
try {
  if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
    throw new Error('Key ID and Secret must be provided in env variables');
  }
  razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET
  });
  console.log("✅ Razorpay initialized successfully");
} catch (e) {
  console.error("⚠️ Razorpay could not be initialized:", e.message);
  console.warn("⚠️ Payment order creation will fail!");
}

// ─────────────────────────────────────────────────────────────
// EMAIL  (Gmail — mpulsedigitalai@gmail.com)
// ─────────────────────────────────────────────────────────────
let transporter;
try {
  if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
    throw new Error('Email user and pass must be provided in env variables');
  }
  transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
  });
  console.log("✅ Nodemailer initialized successfully");
} catch (e) {
  console.error("⚠️ Nodemailer could not be initialized:", e.message);
  console.warn("⚠️ Email notifications will be skipped!");
}

function sendEmail(subject, html) {
  if (!transporter) {
    console.log(`[Mock Email Sent] Subject: ${subject}`);
    return;
  }
  transporter.sendMail({
    from: `"MPULSE DIGITAL AI" <${process.env.EMAIL_USER}>`,
    to: process.env.NOTIFY_EMAIL || 'mpulsedigitalai@gmail.com',
    subject, html
  }).catch(err => console.error('Email error:', err.message));
}

// ─────────────────────────────────────────────────────────────
// GOOGLE SHEETS  (Apps-Script webhook → mpulsedigitalai@gmail.com)
// Set GOOGLE_SHEETS_WEBHOOK_URL in .env to your Apps Script URL.
// The script should read req.body.formType and req.body.payload
// and append a row to the matching sheet tab.
// ─────────────────────────────────────────────────────────────
async function logToSheets(formType, payload) {
  const url = process.env.GOOGLE_SHEETS_WEBHOOK_URL;
  if (!url) { console.warn('GOOGLE_SHEETS_WEBHOOK_URL not set — skipping Sheets log'); return; }
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // Apps Script requires redirect follow for POST → GET quirk
      redirect: 'follow',
      body: JSON.stringify({ formType, payload })
    });
    const text = await res.text();
    console.log(`Sheets log [${formType}]:`, res.status, text.slice(0, 120));
  } catch (err) { console.error('Sheets log error:', err.message); }
}

// ─────────────────────────────────────────────────────────────
// FIRESTORE HELPER
// ─────────────────────────────────────────────────────────────
async function saveDoc(collection, docId, data) {
  // ── SAVE TO MONGODB ──
  try {
    if (getIsConnected()) {
      let model;
      if (collection === 'enrollments') model = models.Enrollment;
      else if (collection === 'callbacks') model = models.Callback;
      else if (collection === 'enquiries') model = models.Enquiry;
      else if (collection === 'signups') model = models.Signup;
      else if (collection === 'demo_bookings') model = models.DemoBooking;

      if (model) {
        const recordData = { ...data };
        if (collection === 'enrollments' || collection === 'demo_bookings') {
          recordData.bookingId = docId;
        }

        if (collection === 'enrollments' || collection === 'demo_bookings') {
          await model.findOneAndUpdate({ bookingId: docId }, recordData, { upsert: true, new: true });
        } else {
          await model.create(recordData);
        }
        console.log(`✅ Saved to MongoDB [${collection}]: ${docId || ''}`);
      }
    } else {
      console.warn(`⚠️ MongoDB not connected — skipping MongoDB save for [${collection}]`);
    }
  } catch (err) {
    console.error(`❌ MongoDB save error (${collection}):`, err.message);
  }

  // ── SAVE TO FIREBASE ──
  try {
    if (db) {
      await db.collection(collection).doc(docId).set({
        ...data,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
      console.log(`✅ Saved to Firestore [${collection}]: ${docId}`);
    } else {
      console.log(`[Mock Firestore Save] ${collection}/${docId}:`, JSON.stringify(data, null, 2));
    }
  } catch (err) {
    console.error(`❌ Firestore save error (${collection}):`, err.message);
  }
}

// ─────────────────────────────────────────────────────────────
// PAYMENT PLAN CONFIG
//
//  One-time:      ₹28,000  (student saves ₹2,000 off ₹30,000)
//  Installment 1: ₹15,000  (due at enrollment)
//  Installment 2: ₹15,000  (due 1 month after enrollment)
//  Total via EMI: ₹30,000
// ─────────────────────────────────────────────────────────────
const PRICE_ONE_TIME = 28000;
const PRICE_INSTALLMENT = 15000;   // each of 2 installments
const PRICE_FULL = 30000;   // total if paying by EMI

function getPlan(planType, installmentNumber) {
  if (planType === 'one-time') {
    return { amount: PRICE_ONE_TIME, label: 'Full Payment — ₹28,000 (save ₹2,000)' };
  }
  if (planType === 'installments') {
    const n = parseInt(installmentNumber, 10);
    if (n === 1) return { amount: PRICE_INSTALLMENT, label: 'Installment 1 of 2 — ₹15,000 (due at enrollment)' };
    if (n === 2) return { amount: PRICE_INSTALLMENT, label: 'Installment 2 of 2 — ₹15,000 (due 1 month after enrollment)' };
  }
  return null;
}

function addOneMonth(dateStr) {
  const d = new Date(dateStr);
  d.setMonth(d.getMonth() + 1);
  return d.toISOString().split('T')[0];
}

function genId(prefix) {
  return `${prefix}-${new Date().getFullYear()}-${Math.floor(100000 + Math.random() * 900000)}`;
}

// ─────────────────────────────────────────────────────────────
// HEALTH CHECK
// ─────────────────────────────────────────────────────────────
app.get('/', (_, res) => res.json({ status: 'ok', service: 'MPULSE DIGITAL AI backend' }));

// ─────────────────────────────────────────────────────────────
// GET PAYMENT PLANS  (optional — used if you want to fetch from frontend)
// ─────────────────────────────────────────────────────────────
app.get('/api/payment-plans', (_, res) => {
  res.json({
    oneTime: { amount: PRICE_ONE_TIME, label: 'Pay in Full — ₹28,000 (save ₹2,000)' },
    installments: {
      totalAmount: PRICE_FULL,
      schedule: [
        { number: 1, amount: PRICE_INSTALLMENT, dueLabel: 'Due at enrollment' },
        { number: 2, amount: PRICE_INSTALLMENT, dueLabel: 'Due 1 month after enrollment' }
      ]
    }
  });
});

// ─────────────────────────────────────────────────────────────
// CREATE RAZORPAY ORDER
// Called from frontend startRazorpay() before opening checkout.
// Amount is calculated SERVER-SIDE — never trust frontend amount.
// ─────────────────────────────────────────────────────────────
app.post('/api/create-order', async (req, res) => {
  try {
    const { planType, installmentNumber, courseName, studentName, studentPhone } = req.body;

    if (!planType || !courseName || !studentName || !studentPhone)
      return res.status(400).json({ error: 'planType, courseName, studentName and studentPhone are required.' });

    const plan = getPlan(planType, installmentNumber);
    if (!plan) return res.status(400).json({ error: 'Invalid payment plan.' });

    if (!razorpay) {
      return res.status(500).json({ error: 'Razorpay is not initialized on the server. Please check environment variables.' });
    }

    const order = await razorpay.orders.create({
      amount: plan.amount * 100,   // paise
      currency: 'INR',
      receipt: 'rcpt_' + Date.now(),
      notes: { courseName, studentName, studentPhone, planType, installmentNumber: installmentNumber || '' }
    });

    res.json({
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      keyId: process.env.RAZORPAY_KEY_ID,
      planLabel: plan.label
    });
  } catch (err) {
    console.error('create-order error:', err);
    res.status(500).json({ error: 'Failed to create Razorpay order.' });
  }
});

// ─────────────────────────────────────────────────────────────
// TEST ENV VARS
// GET /api/test-env
// ─────────────────────────────────────────────────────────────
app.get('/api/test-env', (req, res) => {
  res.json({
    razorpay_key_id_set: !!process.env.RAZORPAY_KEY_ID,
    razorpay_secret_set: !!process.env.RAZORPAY_KEY_SECRET,
    firebase_set: !!process.env.FIREBASE_SERVICE_ACCOUNT_JSON,
    sheets_webhook_set: !!process.env.GOOGLE_SHEETS_WEBHOOK_URL,
    email_user_set: !!process.env.EMAIL_USER,
    sheets_url_preview: (process.env.GOOGLE_SHEETS_WEBHOOK_URL || '').slice(0, 60) + '...'
  });
});

app.get('/api/test-email-trigger', async (req, res) => {
  if (!transporter) {
    return res.status(500).json({ error: 'Nodemailer is not initialized' });
  }
  try {
    const info = await transporter.sendMail({
      from: `"MPULSE DIGITAL AI" <${process.env.EMAIL_USER}>`,
      to: process.env.NOTIFY_EMAIL || 'mpulsedigitalai@gmail.com',
      subject: 'Render SMTP Test Route',
      text: 'SMTP test successful!'
    });
    res.json({ success: true, message: 'Email sent successfully!', messageId: info.messageId });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// TEST SHEETS — fires a test row directly to Enrollments tab
// GET /api/test-sheets
// ─────────────────────────────────────────────────────────────
app.get('/api/test-sheets', async (req, res) => {
  try {
    await logToSheets('Enrollments', {
      'Booking ID': 'TEST-001',
      'Name': 'Test Student',
      'Phone': '9999999999',
      'Email': 'test@test.com',
      'Student Status': 'Working Professional',
      'Course': 'AI-Powered Digital Marketing Course',
      'Message': 'Test row from /api/test-sheets',
      'Plan Type': 'one-time',
      'Installment #': '',
      'Plan Label': 'Full Payment — ₹28,000',
      'Amount Paid (₹)': 28000,
      'Demo Date': '2026-07-01',
      'Time Slot': '6:00 PM',
      'Mode': 'Live Online',
      'Razorpay Order ID': 'order_TEST123',
      'Razorpay Payment ID': 'pay_TEST123',
      'Payment Status': 'paid',
      'Inst. 2 Due Date': ''
    });
    res.json({ success: true, message: 'Check your Enrollments sheet tab!' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// TEST FULL ENROLLMENT FLOW — simulates a real payment without
// going through Razorpay. Saves to Firestore + Sheets.
// GET /api/test-enrollment
// ─────────────────────────────────────────────────────────────
app.get('/api/test-enrollment', async (req, res) => {
  try {
    const bookingId = genId('MPF');
    const today = new Date().toISOString().split('T')[0];

    const record = {
      bookingId,
      razorpay_order_id: 'order_SIMULATED',
      razorpay_payment_id: 'pay_SIMULATED',
      name: 'Test Enrollment',
      phone: '9999999999',
      email: 'test@mpulse.com',
      status: 'Working Professional',
      course: 'AI-Powered Digital Marketing Course',
      message: 'Simulated enrollment test',
      planType: 'one-time',
      installmentNumber: '',
      planLabel: 'Full Payment — ₹28,000',
      amountPaid: 28000,
      date: today,
      slot: '6:00 PM',
      mode: 'Live Online',
      type: 'enrollment',
      paymentStatus: 'paid'
    };

    console.log('TEST: saving to Firestore...');
    await saveDoc('enrollments', bookingId, record);
    console.log('TEST: Firestore done ✅');

    console.log('TEST: sending to Sheets...');
    await logToSheets('Enrollments', {
      'Booking ID': bookingId,
      'Name': record.name,
      'Phone': record.phone,
      'Email': record.email,
      'Student Status': record.status,
      'Course': record.course,
      'Message': record.message,
      'Plan Type': record.planType,
      'Installment #': record.installmentNumber,
      'Plan Label': record.planLabel,
      'Amount Paid (₹)': record.amountPaid,
      'Demo Date': record.date,
      'Time Slot': record.slot,
      'Mode': record.mode,
      'Razorpay Order ID': record.razorpay_order_id,
      'Razorpay Payment ID': record.razorpay_payment_id,
      'Payment Status': record.paymentStatus,
      'Inst. 2 Due Date': ''
    });
    console.log('TEST: Sheets done ✅');

    res.json({
      success: true,
      bookingId,
      message: 'Enrollment test complete — check Firestore + Sheets!'
    });
  } catch (err) {
    console.error('TEST enrollment error:', err);
    res.status(500).json({ success: false, error: err.message, stack: err.stack });
  }
});

// ─────────────────────────────────────────────────────────────
// VERIFY PAYMENT  (called after Razorpay checkout succeeds)
// Saves full enrollment record to:
//   • Firestore  → collection: "enrollments"
//   • Google Sheets → tab: "Enrollments"
//   • Email notification → mpulsedigitalai@gmail.com
// ─────────────────────────────────────────────────────────────
app.post('/api/verify-payment', async (req, res) => {
  try {
    const {
      razorpay_order_id, razorpay_payment_id, razorpay_signature,
      enrollment, planType, installmentNumber
    } = req.body;

    console.log('verify-payment received:', {
      razorpay_order_id, razorpay_payment_id,
      planType, installmentNumber,
      enrollment_name: enrollment?.name,
      enrollment_course: enrollment?.course
    });

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature)
      return res.status(400).json({ error: 'Missing Razorpay payment fields.' });

    // ── Signature verification ──
    const expected = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest('hex');

    console.log('Signature check:', {
      expected: expected.slice(0, 20) + '...',
      received: razorpay_signature.slice(0, 20) + '...',
      match: expected === razorpay_signature
    });

    if (expected !== razorpay_signature) {
      console.error('❌ Signature mismatch — check RAZORPAY_KEY_SECRET on Render');
      return res.status(400).json({ verified: false, error: 'Payment signature mismatch.' });
    }

    const plan = getPlan(planType, installmentNumber);
    const bookingId = genId('MPF');
    const today = new Date().toISOString().split('T')[0];

    const record = {
      bookingId,
      razorpay_order_id,
      razorpay_payment_id,
      name: enrollment?.name || '',
      phone: enrollment?.phone || '',
      email: enrollment?.email || '',
      status: enrollment?.status || '',
      course: enrollment?.course || '',
      message: enrollment?.message || '',
      planType: planType || '',
      installmentNumber: installmentNumber || '',
      planLabel: plan ? plan.label : '',
      amountPaid: plan ? plan.amount : 0,
      date: enrollment?.date || '',
      slot: enrollment?.slot || '',
      mode: enrollment?.mode || '',
      type: 'enrollment',
      paymentStatus: 'paid'
    };

    // Track installment 2 due date when installment 1 is paid
    if (planType === 'installments' && parseInt(installmentNumber, 10) === 1) {
      record.installment2DueDate = addOneMonth(today);
      record.installment2Paid = false;
      record.paymentStatus = 'installment_1_paid';
    }
    if (planType === 'installments' && parseInt(installmentNumber, 10) === 2) {
      record.paymentStatus = 'fully_paid';
    }

    // ── Save to Firestore ──
    console.log('Saving to Firestore:', bookingId);
    await saveDoc('enrollments', bookingId, record);
    console.log('✅ Firestore save done:', bookingId);

    // ── Log to Google Sheets ──
    console.log('Sending to Google Sheets...');
    await logToSheets('Enrollments', {
      'Booking ID': bookingId,
      'Name': record.name,
      'Phone': record.phone,
      'Email': record.email,
      'Student Status': record.status,
      'Course': record.course,
      'Message': record.message,
      'Plan Type': record.planType,
      'Installment #': record.installmentNumber,
      'Plan Label': record.planLabel,
      'Amount Paid (₹)': record.amountPaid,
      'Demo Date': record.date,
      'Time Slot': record.slot,
      'Mode': record.mode,
      'Razorpay Order ID': razorpay_order_id,
      'Razorpay Payment ID': razorpay_payment_id,
      'Payment Status': record.paymentStatus,
      'Inst. 2 Due Date': record.installment2DueDate || ''
    });

    console.log('✅ Sheets log done');

    // ── Email notification ──
    sendEmail(
      `🎉 Payment Received: ${record.course} — ${record.name}`,
      `<div style="font-family:Arial,sans-serif;max-width:580px;">
        <h2 style="color:#6d28d9;">New Enrollment Payment</h2>
        <table style="width:100%;border-collapse:collapse;font-size:14px;">
          <tr><td style="padding:8px;font-weight:bold;background:#f5f3ff;">Booking ID</td><td style="padding:8px;">${bookingId}</td></tr>
          <tr><td style="padding:8px;font-weight:bold;background:#f5f3ff;">Name</td><td style="padding:8px;">${record.name}</td></tr>
          <tr><td style="padding:8px;font-weight:bold;background:#f5f3ff;">Phone</td><td style="padding:8px;">${record.phone}</td></tr>
          <tr><td style="padding:8px;font-weight:bold;background:#f5f3ff;">Email</td><td style="padding:8px;">${record.email || '—'}</td></tr>
          <tr><td style="padding:8px;font-weight:bold;background:#f5f3ff;">Student Status</td><td style="padding:8px;">${record.status || '—'}</td></tr>
          <tr><td style="padding:8px;font-weight:bold;background:#f5f3ff;">Course</td><td style="padding:8px;">${record.course}</td></tr>
          <tr><td style="padding:8px;font-weight:bold;background:#f5f3ff;">Payment Plan</td><td style="padding:8px;">${record.planLabel}</td></tr>
          <tr><td style="padding:8px;font-weight:bold;background:#f5f3ff;">Amount Paid</td><td style="padding:8px;color:#059669;font-weight:bold;">₹${record.amountPaid.toLocaleString('en-IN')}</td></tr>
          <tr><td style="padding:8px;font-weight:bold;background:#f5f3ff;">Demo Date</td><td style="padding:8px;">${record.date || '—'}</td></tr>
          <tr><td style="padding:8px;font-weight:bold;background:#f5f3ff;">Time Slot</td><td style="padding:8px;">${record.slot || '—'}</td></tr>
          <tr><td style="padding:8px;font-weight:bold;background:#f5f3ff;">Mode</td><td style="padding:8px;">${record.mode || '—'}</td></tr>
          <tr><td style="padding:8px;font-weight:bold;background:#f5f3ff;">Razorpay Payment ID</td><td style="padding:8px;">${razorpay_payment_id}</td></tr>
          ${record.installment2DueDate ? `<tr><td style="padding:8px;font-weight:bold;background:#fef3c7;">Instalment 2 Due</td><td style="padding:8px;color:#d97706;">${record.installment2DueDate}</td></tr>` : ''}
        </table>
        ${record.installment2DueDate ? `<p style="margin-top:12px;font-size:13px;color:#92400e;">⚠️ Please follow up for Installment 2 (₹15,000) on <strong>${record.installment2DueDate}</strong>.</p>` : ''}
      </div>`
    );

    console.log('✅ Email sent');
    res.json({ verified: true, bookingId, amountPaid: record.amountPaid, planLabel: record.planLabel });
  } catch (err) {
    console.error('❌ verify-payment FULL ERROR:', err);
    res.status(500).json({ error: 'Payment verification failed due to a server error.' });
  }
});

// ─────────────────────────────────────────────────────────────
// FREE DEMO BOOKING  (AI courses — no payment)
// Called from frontend confirmFreeDemo()
// Saves to:
//   • Firestore  → collection: "demo_bookings"
//   • Google Sheets → tab: "Demo Bookings"
//   • Email notification
// ─────────────────────────────────────────────────────────────
app.post('/api/demo-booking', async (req, res) => {
  try {
    const { name, phone, email, status, course, date, slot, mode, message } = req.body;

    if (!name || !phone)
      return res.status(400).json({ error: 'Name and phone are required.' });

    const bookingId = genId('MPD');

    const record = {
      bookingId,
      name,
      phone,
      email: email || '',
      status: status || '',
      course: course || '',
      date: date || '',
      slot: slot || '',
      mode: mode || '',
      message: message || '',
      type: 'demo_booking',
      paymentStatus: 'free_demo'
    };

    // ── Save to Firestore ──
    await saveDoc('demo_bookings', bookingId, record);

    // ── Log to Google Sheets ──
    await logToSheets('Demo Bookings', {
      'Booking ID': bookingId,
      'Name': record.name,
      'Phone': record.phone,
      'Email': record.email,
      'Student Status': record.status,
      'Course': record.course,
      'Demo Date': record.date,
      'Time Slot': record.slot,
      'Mode': record.mode,
      'Message': record.message
    });

    // ── Email notification ──
    sendEmail(
      `📅 Free Demo Booked: ${record.course} — ${record.name}`,
      `<div style="font-family:Arial,sans-serif;max-width:580px;">
        <h2 style="color:#6d28d9;">Free Demo Class Booking</h2>
        <table style="width:100%;border-collapse:collapse;font-size:14px;">
          <tr><td style="padding:8px;font-weight:bold;background:#f5f3ff;">Booking ID</td><td style="padding:8px;">${bookingId}</td></tr>
          <tr><td style="padding:8px;font-weight:bold;background:#f5f3ff;">Name</td><td style="padding:8px;">${record.name}</td></tr>
          <tr><td style="padding:8px;font-weight:bold;background:#f5f3ff;">Phone</td><td style="padding:8px;">${record.phone}</td></tr>
          <tr><td style="padding:8px;font-weight:bold;background:#f5f3ff;">Email</td><td style="padding:8px;">${record.email || '—'}</td></tr>
          <tr><td style="padding:8px;font-weight:bold;background:#f5f3ff;">Student Status</td><td style="padding:8px;">${record.status || '—'}</td></tr>
          <tr><td style="padding:8px;font-weight:bold;background:#f5f3ff;">Course</td><td style="padding:8px;">${record.course}</td></tr>
          <tr><td style="padding:8px;font-weight:bold;background:#f5f3ff;">Demo Date</td><td style="padding:8px;">${record.date || '—'}</td></tr>
          <tr><td style="padding:8px;font-weight:bold;background:#f5f3ff;">Time Slot</td><td style="padding:8px;">${record.slot || '—'}</td></tr>
          <tr><td style="padding:8px;font-weight:bold;background:#f5f3ff;">Mode</td><td style="padding:8px;">${record.mode || '—'}</td></tr>
          <tr><td style="padding:8px;font-weight:bold;background:#f5f3ff;">Message</td><td style="padding:8px;">${record.message || '—'}</td></tr>
        </table>
        <p style="margin-top:12px;font-size:13px;color:#6d28d9;">📞 Call within 2 hours to confirm this slot.</p>
      </div>`
    );

    res.json({ success: true, bookingId });
  } catch (err) {
    console.error('demo-booking error:', err);
    res.status(500).json({ error: 'Could not save demo booking.' });
  }
});

// ─────────────────────────────────────────────────────────────
// ENQUIRY FORM  (contact section on the page)
// ─────────────────────────────────────────────────────────────
app.post('/api/enquiry', async (req, res) => {
  try {
    const { name, phone, course, message } = req.body;
    if (!name || !phone) return res.status(400).json({ error: 'Name and phone are required.' });

    const docId = 'ENQ-' + Date.now();
    await saveDoc('enquiries', docId, { name, phone, course: course || '', message: message || '', type: 'enquiry' });

    await logToSheets('Enquiries', {
      'Name': name, 'Phone': phone, 'Course': course || '', 'Message': message || ''
    });

    sendEmail(
      `📩 New Enquiry: ${name}`,
      `<div style="font-family:Arial,sans-serif;">
        <h3 style="color:#6d28d9;">Website Enquiry</h3>
        <p><b>Name:</b> ${name}</p>
        <p><b>Phone:</b> ${phone}</p>
        <p><b>Course:</b> ${course || '—'}</p>
        <p><b>Message:</b> ${message || '—'}</p>
      </div>`
    );

    res.json({ success: true });
  } catch (err) {
    console.error('enquiry error:', err);
    res.status(500).json({ error: 'Could not submit enquiry.' });
  }
});

// ─────────────────────────────────────────────────────────────
// CALLBACK REQUEST
// ─────────────────────────────────────────────────────────────
app.post('/api/callback', async (req, res) => {
  try {
    const { name, phone, preferredTime } = req.body;
    if (!name || !phone) return res.status(400).json({ error: 'Name and phone are required.' });

    const docId = 'CB-' + Date.now();
    await saveDoc('callbacks', docId, { name, phone, preferredTime: preferredTime || 'Anytime', type: 'callback' });

    await logToSheets('Callbacks', {
      'Name': name, 'Phone': phone, 'Preferred Time': preferredTime || 'Anytime', 'Status': 'pending'
    });

    sendEmail(
      `📞 Callback Request: ${name}`,
      `<div style="font-family:Arial,sans-serif;">
        <h3 style="color:#6d28d9;">Callback Request</h3>
        <p><b>Name:</b> ${name}</p>
        <p><b>Phone:</b> ${phone}</p>
        <p><b>Preferred Time:</b> ${preferredTime || 'Anytime'}</p>
      </div>`
    );

    res.json({ success: true });
  } catch (err) {
    console.error('callback error:', err);
    res.status(500).json({ error: 'Could not submit callback request.' });
  }
});

// ─────────────────────────────────────────────────────────────
// SIGN-UP POPUP
// ─────────────────────────────────────────────────────────────
app.post('/api/signup', async (req, res) => {
  try {
    const { name, phone, email } = req.body;
    if (!name || !phone) return res.status(400).json({ error: 'Name and phone are required.' });

    const docId = 'SU-' + Date.now();
    await saveDoc('signups', docId, { name, phone, email: email || '', type: 'signup' });

    await logToSheets('Signups', { 'Name': name, 'Phone': phone, 'Email': email || '' });

    sendEmail(
      `🎯 New Sign-Up: ${name}`,
      `<div style="font-family:Arial,sans-serif;">
        <h3 style="color:#6d28d9;">Pop-Up Sign-Up</h3>
        <p><b>Name:</b> ${name}</p>
        <p><b>Phone:</b> ${phone}</p>
        <p><b>Email:</b> ${email || '—'}</p>
      </div>`
    );

    res.json({ success: true });
  } catch (err) {
    console.error('signup error:', err);
    res.status(500).json({ error: 'Could not save sign-up.' });
  }
});

// ─────────────────────────────────────────────────────────────
// ADMIN — CHECK OVERDUE INSTALLMENTS
// GET /api/overdue-students?adminKey=YOUR_KEY
// ─────────────────────────────────────────────────────────────
app.get('/api/overdue-students', async (req, res) => {
  try {
    if (req.query.adminKey !== process.env.ADMIN_KEY)
      return res.status(403).json({ error: 'Unauthorized.' });

    if (!db) {
      return res.status(500).json({ error: 'Firestore is not initialized.' });
    }

    const today = new Date().toISOString().split('T')[0];
    const snapshot = await db.collection('enrollments')
      .where('planType', '==', 'installments')
      .where('installmentNumber', '==', 1)
      .get();

    const overdue = [];
    snapshot.forEach(doc => {
      const d = doc.data();
      if (d.installment2Paid) return;
      if (d.installment2DueDate && d.installment2DueDate < today) {
        overdue.push({
          bookingId: d.bookingId,
          name: d.name,
          phone: d.phone,
          email: d.email,
          course: d.course,
          overdueOn: 'Installment 2 — ₹15,000',
          dueDate: d.installment2DueDate,
          daysOverdue: Math.floor((new Date(today) - new Date(d.installment2DueDate)) / 86400000)
        });
      }
    });

    res.json({ overdueCount: overdue.length, overdueStudents: overdue });
  } catch (err) {
    console.error('overdue-students error:', err);
    res.status(500).json({ error: 'Could not fetch overdue students.' });
  }
});

// ─────────────────────────────────────────────────────────────
// ADMIN — MARK INSTALLMENT 2 AS PAID MANUALLY
// POST /api/mark-installment-paid
// Body: { adminKey, bookingId }
// ─────────────────────────────────────────────────────────────
app.post('/api/mark-installment-paid', async (req, res) => {
  try {
    const { adminKey, bookingId } = req.body;
    if (adminKey !== process.env.ADMIN_KEY)
      return res.status(403).json({ error: 'Unauthorized.' });
    if (!bookingId)
      return res.status(400).json({ error: 'bookingId is required.' });

    if (!db) {
      return res.status(500).json({ error: 'Firestore is not initialized.' });
    }

    await db.collection('enrollments').doc(bookingId).update({
      installment2Paid: true,
      paymentStatus: 'fully_paid'
    });

    res.json({ success: true });
  } catch (err) {
    console.error('mark-installment-paid error:', err);
    res.status(500).json({ error: 'Could not update installment status.' });
  }
});

// ─────────────────────────────────────────────────────────────
// ADMIN — GET ALL DATA FOR DASHBOARD
// GET /api/admin/all-data?adminKey=YOUR_KEY
// ─────────────────────────────────────────────────────────────
app.get('/api/admin/all-data', async (req, res) => {
  try {
    const { adminKey } = req.query;
    if (!adminKey || adminKey !== process.env.ADMIN_KEY) {
      return res.status(403).json({ error: 'Unauthorized. Invalid adminKey.' });
    }

    let enrollments = [];
    let callbacks = [];
    let enquiries = [];
    let signups = [];
    let demoBookings = [];

    if (getIsConnected()) {
      enrollments = await models.Enrollment.find({}).sort({ createdAt: -1 });
      callbacks = await models.Callback.find({}).sort({ createdAt: -1 });
      enquiries = await models.Enquiry.find({}).sort({ createdAt: -1 });
      signups = await models.Signup.find({}).sort({ createdAt: -1 });
      demoBookings = await models.DemoBooking.find({}).sort({ createdAt: -1 });
    } else if (db) {
      const snapEnr = await db.collection('enrollments').get();
      const snapCb = await db.collection('callbacks').get();
      const snapEnq = await db.collection('enquiries').get();
      const snapSu = await db.collection('signups').get();
      const snapDb = await db.collection('demo_bookings').get();

      snapEnr.forEach(doc => enrollments.push(doc.data()));
      snapCb.forEach(doc => callbacks.push(doc.data()));
      snapEnq.forEach(doc => enquiries.push(doc.data()));
      snapSu.forEach(doc => signups.push(doc.data()));
      snapDb.forEach(doc => demoBookings.push(doc.data()));
    } else {
      return res.status(503).json({ error: 'No database connection available.' });
    }

    res.json({ enrollments, callbacks, enquiries, signups, demoBookings });
  } catch (err) {
    console.error('admin all-data error:', err);
    res.status(500).json({ error: 'Failed to retrieve admin data.' });
  }
});

// ─────────────────────────────────────────────────────────────
// ADMIN — UPDATE CALLBACK STATUS
// POST /api/admin/update-callback-status
// Body: { adminKey, callbackId, status }
// ─────────────────────────────────────────────────────────────
app.post('/api/admin/update-callback-status', async (req, res) => {
  try {
    const { adminKey, callbackId, status } = req.body;
    if (!adminKey || adminKey !== process.env.ADMIN_KEY) {
      return res.status(403).json({ error: 'Unauthorized. Invalid adminKey.' });
    }
    if (!callbackId || !status) {
      return res.status(400).json({ error: 'callbackId and status are required.' });
    }

    if (getIsConnected()) {
      await models.Callback.findByIdAndUpdate(callbackId, { status });
      res.json({ success: true, message: 'Callback status updated in MongoDB.' });
    } else if (db) {
      await db.collection('callbacks').doc(callbackId).update({ status });
      res.json({ success: true, message: 'Callback status updated in Firestore.' });
    } else {
      res.status(503).json({ error: 'No database connection available.' });
    }
  } catch (err) {
    console.error('update-callback-status error:', err);
    res.status(500).json({ error: 'Failed to update callback status.' });
  }
});

// ─────────────────────────────────────────────────────────────
// ADMIN — DELETE ITEM
// POST /api/admin/delete-item
// Body: { adminKey, type, id }
// ─────────────────────────────────────────────────────────────
app.post('/api/admin/delete-item', async (req, res) => {
  try {
    const { adminKey, type, id } = req.body;
    if (!adminKey || adminKey !== process.env.ADMIN_KEY) {
      return res.status(403).json({ error: 'Unauthorized. Invalid adminKey.' });
    }
    if (!type || !id) {
      return res.status(400).json({ error: 'type and id are required.' });
    }

    let deleted = false;

    if (getIsConnected()) {
      const modelMap = {
        enrollments: models.Enrollment,
        callbacks: models.Callback,
        demos: models.DemoBooking,
        enquiries: models.Enquiry,
        signups: models.Signup
      };
      const Model = modelMap[type];
      if (Model) {
        await Model.findByIdAndDelete(id);
        deleted = true;
      }
    } else if (db) {
      const collectionMap = {
        enrollments: 'enrollments',
        callbacks: 'callbacks',
        demos: 'demoBookings',
        enquiries: 'enquiries',
        signups: 'signups'
      };
      const col = collectionMap[type];
      if (col) {
        await db.collection(col).doc(id).delete();
        deleted = true;
      }
    }

    if (deleted) {
      res.json({ success: true, message: 'Item deleted successfully.' });
    } else {
      res.status(400).json({ error: 'Invalid item type or database connection unavailable.' });
    }
  } catch (err) {
    console.error('delete-item error:', err);
    res.status(500).json({ error: 'Failed to delete item.' });
  }
});


// ─────────────────────────────────────────────────────────────
// LMS & MEMBERSHIP SYSTEM API
// ─────────────────────────────────────────────────────────────

// Password Hashing Utility Functions (PBKDF2)
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 1000, 64, 'sha512').toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, storedPassword) {
  if (!storedPassword || !storedPassword.includes(':')) {
    // Legacy plain text fallback
    return password === storedPassword;
  }
  const [salt, hash] = storedPassword.split(':');
  const checkHash = crypto.pbkdf2Sync(password, salt, 1000, 64, 'sha512').toString('hex');
  return hash === checkHash;
}

// 1. Student Signup
app.post('/api/auth/signup', async (req, res) => {
  try {
    const { name, email, phone, password } = req.body;
    if (!name || !email || !phone || !password) {
      return res.status(400).json({ error: 'All fields are required.' });
    }

    if (!getIsConnected()) {
      return res.status(503).json({ error: 'Database connection unavailable.' });
    }

    // Check if user already exists
    const existing = await models.Student.findOne({ email });
    if (existing) {
      return res.status(400).json({ error: 'Account already exists with this email.' });
    }

    // Check if email has active paid enrollment
    const enrollment = await models.Enrollment.findOne({
      email,
      paymentStatus: { $in: ['paid', 'installment_1_paid', 'fully_paid'] }
    });
    const isPaid = !!enrollment;

    const newStudent = new models.Student({
      name,
      email,
      phone,
      password: hashPassword(password),
      isPaid
    });

    await newStudent.save();
    res.json({ success: true, user: { name, email, phone, isPaid } });
  } catch (err) {
    console.error('auth signup error:', err);
    res.status(500).json({ error: 'Failed to create account.' });
  }
});

// 2. Student Login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required.' });
    }

    if (!getIsConnected()) {
      return res.status(503).json({ error: 'Database connection unavailable.' });
    }

    const student = await models.Student.findOne({ email });
    if (!student || !verifyPassword(password, student.password)) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    // Upgrade plain-text passwords to secure hash on login
    if (!student.password.includes(':')) {
      student.password = hashPassword(password);
      await student.save();
      console.log(`🔒 Upgraded password to secure hash for student: ${email}`);
    }

    // Refresh membership paid status dynamically if they enrolled recently
    const enrollment = await models.Enrollment.findOne({
      email,
      paymentStatus: { $in: ['paid', 'installment_1_paid', 'fully_paid'] }
    });
    if (enrollment && !student.isPaid) {
      student.isPaid = true;
      await student.save();
    }

    res.json({
      success: true,
      user: {
        name: student.name,
        email: student.email,
        phone: student.phone,
        isPaid: student.isPaid
      }
    });
  } catch (err) {
    console.error('auth login error:', err);
    res.status(500).json({ error: 'Authentication failed.' });
  }
});

// 3. Student Portal Data Loader (Live classes, recordings, resources)
app.get('/api/student/portal-data', async (req, res) => {
  try {
    const { email } = req.query;
    if (!email) {
      return res.status(400).json({ error: 'email query parameter is required.' });
    }

    if (!getIsConnected()) {
      return res.status(503).json({ error: 'Database connection unavailable.' });
    }

    const student = await models.Student.findOne({ email });
    if (!student) {
      return res.status(404).json({ error: 'Student not found.' });
    }

    // Dynamic paid-status check
    const enrollment = await models.Enrollment.findOne({
      email,
      paymentStatus: { $in: ['paid', 'installment_1_paid', 'fully_paid'] }
    });
    if (enrollment && !student.isPaid) {
      student.isPaid = true;
      await student.save();
    }

    const liveClasses = await models.LiveClass.find({}).sort({ date: 1, time: 1 });
    const recordingsRaw = await models.Recording.find({}).sort({ createdAt: -1 });
    const resourcesRaw = await models.Resource.find({}).sort({ createdAt: -1 });

    // Lock content if user is unpaid
    const recordings = student.isPaid
      ? recordingsRaw
      : recordingsRaw.map(r => ({ _id: r._id, title: r.title, videoUrl: 'LOCKED' }));

    const resources = student.isPaid
      ? resourcesRaw
      : resourcesRaw.map(r => ({ _id: r._id, title: r.title, fileUrl: 'LOCKED', type: r.type }));

    res.json({
      isPaid: student.isPaid,
      liveClasses,
      recordings,
      resources
    });
  } catch (err) {
    console.error('portal-data error:', err);
    res.status(500).json({ error: 'Failed to retrieve classroom materials.' });
  }
});

// 4. Admin LMS - Schedule Class
app.post('/api/admin/schedule-class', async (req, res) => {
  try {
    const { adminKey, title, date, time, channelName } = req.body;
    if (!adminKey || adminKey !== process.env.ADMIN_KEY) {
      return res.status(403).json({ error: 'Unauthorized.' });
    }
    if (!title || !date || !time || !channelName) {
      return res.status(400).json({ error: 'All fields are required.' });
    }

    if (!getIsConnected()) {
      return res.status(503).json({ error: 'Database connection unavailable.' });
    }

    const newClass = new models.LiveClass({ title, date, time, channelName });
    await newClass.save();
    res.json({ success: true, message: 'Live class scheduled successfully.' });
  } catch (err) {
    console.error('schedule-class error:', err);
    res.status(500).json({ error: 'Failed to schedule live class.' });
  }
});

// 5. Admin LMS - Upload Recording
app.post('/api/admin/upload-recording', async (req, res) => {
  try {
    const { adminKey, title, videoUrl } = req.body;
    if (!adminKey || adminKey !== process.env.ADMIN_KEY) {
      return res.status(403).json({ error: 'Unauthorized.' });
    }
    if (!title || !videoUrl) {
      return res.status(400).json({ error: 'All fields are required.' });
    }

    if (!getIsConnected()) {
      return res.status(503).json({ error: 'Database connection unavailable.' });
    }

    const newRec = new models.Recording({ title, videoUrl });
    await newRec.save();
    res.json({ success: true, message: 'Class recording saved.' });
  } catch (err) {
    console.error('upload-recording error:', err);
    res.status(500).json({ error: 'Failed to upload recording.' });
  }
});

// 6. Admin LMS - Upload Study Resource
app.post('/api/admin/upload-resource', async (req, res) => {
  try {
    const { adminKey, title, fileUrl, type } = req.body;
    if (!adminKey || adminKey !== process.env.ADMIN_KEY) {
      return res.status(403).json({ error: 'Unauthorized.' });
    }
    if (!title || !fileUrl) {
      return res.status(400).json({ error: 'All fields are required.' });
    }

    if (!getIsConnected()) {
      return res.status(503).json({ error: 'Database connection unavailable.' });
    }

    const newRes = new models.Resource({ title, fileUrl, type });
    await newRes.save();
    res.json({ success: true, message: 'Study materials posted.' });
  } catch (err) {
    console.error('upload-resource error:', err);
    res.status(500).json({ error: 'Failed to upload study resources.' });
  }
});

// 7. Admin LMS - Toggle user paid state manually
app.post('/api/admin/toggle-user-paid', async (req, res) => {
  try {
    const { adminKey, email, isPaid } = req.body;
    if (!adminKey || adminKey !== process.env.ADMIN_KEY) {
      return res.status(403).json({ error: 'Unauthorized.' });
    }

    if (!getIsConnected()) {
      return res.status(503).json({ error: 'Database connection unavailable.' });
    }

    await models.Student.findOneAndUpdate({ email }, { isPaid });
    res.json({ success: true, message: `Membership status updated for ${email}` });
  } catch (err) {
    console.error('toggle-user-paid error:', err);
    res.status(500).json({ error: 'Failed to update student membership.' });
  }
});

// 8. Admin LMS - Get list of students for LMS panel
app.get('/api/admin/lms-students', async (req, res) => {
  try {
    const { adminKey } = req.query;
    if (!adminKey || adminKey !== process.env.ADMIN_KEY) {
      return res.status(403).json({ error: 'Unauthorized.' });
    }

    if (!getIsConnected()) {
      return res.status(503).json({ error: 'Database connection unavailable.' });
    }

    const students = await models.Student.find({}).sort({ createdAt: -1 });
    res.json({ students });
  } catch (err) {
    console.error('lms-students error:', err);
    res.status(500).json({ error: 'Failed to fetch student accounts.' });
  }
});



// ─────────────────────────────────────────────────────────────
// AGORA TOKEN GENERATOR
// GET /api/agora-token?channelName=ROOM_ID&role=publisher/subscriber
// ─────────────────────────────────────────────────────────────
app.get('/api/agora-token', (req, res) => {
  try {
    const appId = process.env.AGORA_APP_ID;
    const appCertificate = process.env.AGORA_APP_CERTIFICATE;

    if (!appId || !appCertificate) {
      return res.status(500).json({ error: 'Agora credentials are not set on the server.' });
    }

    const channelName = req.query.channelName;
    if (!channelName) {
      return res.status(400).json({ error: 'channelName is required.' });
    }

    let role = RtcRole.SUBSCRIBER;
    if (req.query.role === 'publisher') {
      role = RtcRole.PUBLISHER;
    }

    const uid = parseInt(req.query.uid, 10) || 0;
    const expirationTimeInSeconds = 7200; // 2 hours
    const currentTimestamp = Math.floor(Date.now() / 1000);
    const privilegeExpiredTs = currentTimestamp + expirationTimeInSeconds;

    const token = RtcTokenBuilder.buildTokenWithUid(
      appId,
      appCertificate,
      channelName,
      uid,
      role,
      privilegeExpiredTs
    );

    res.json({ token, appId });
  } catch (err) {
    console.error('agora-token generation error:', err);
    res.status(500).json({ error: 'Failed to generate Agora token.' });
  }
});

// ─────────────────────────────────────────────────────────────
// AI CHATBOT ROUTE
// POST /api/chat
// Body: { message, history }
// ─────────────────────────────────────────────────────────────
app.post('/api/chat', async (req, res) => {
  try {
    const { message, history } = req.body;
    if (!message) {
      return res.status(400).json({ error: 'message is required.' });
    }

    const geminiKey = process.env.GEMINI_API_KEY;
    if (!geminiKey) {
      return res.json({
        reply: "Hi! I am MDA, your AI assistant. It looks like my Google Gemini API Key is not configured yet on Render. However, I can tell you that MPULSE DIGITAL AI offers premium courses in Generative AI, Digital Marketing, and Machine Learning! How can I help you contact our mentors today?"
      });
    }

    const systemInstruction = `You are MDA, the friendly AI assistant for MPULSE DIGITAL AI, an institute specializing in AI-powered digital marketing, Machine Learning,Digital Marketing, Generative AI, and data science courses.
Key details to answer users:
- Location: Local classroom classes & Live Online classes.
- Courses:
  1. Generative AI & Prompt Engineering (6 weeks)
  2. AI Tools & Productivity Mastery (4 weeks)
  3. AI Agents & Automation Building (8 weeks)
  4. Machine Learning Engineering (6 months)
  5. Deep Learning with TensorFlow (5 months)
  6. Computer Vision & NLP (4 months)
  7. Python for Data & AI (4 months)
  8. Data Science & Analytics (6 months)
  9. MLOps & AI Deployment (5 months)
  10. LLMs & RAG Systems (4 months)
  11. AI Job Readiness Bootcamp (6 months)
- Pricing:
  - One-time: ₹28,000 (saves ₹2,000)
  - Installment 1: ₹15,000 (due at enrollment)
  - Installment 2: ₹15,000 (due 1 month after enrollment)
  - Total: ₹30,000
- Call to Action: Strongly encourage them to click the 'Book Free Demo Class' or 'Request Callback' button to speak with a human mentor!
Keep your answers brief, structured with bullet points, and highly engaging!`;

    const contents = [];
    if (history && Array.isArray(history)) {
      history.forEach(item => {
        contents.push({
          role: item.role === 'user' ? 'user' : 'model',
          parts: [{ text: item.text }]
        });
      });
    }
    contents.push({ role: 'user', parts: [{ text: message }] });

    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiKey}`;

    const apiResponse = await fetch(geminiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents,
        systemInstruction: { parts: [{ text: systemInstruction }] },
        generationConfig: { maxOutputTokens: 350, temperature: 0.7 }
      })
    });

    if (!apiResponse.ok) {
      const errorText = await apiResponse.text();
      console.error('Gemini API Error details:', errorText);
      throw new Error(`Gemini API returned status ${apiResponse.status}`);
    }

    const responseData = await apiResponse.json();
    const reply = responseData.candidates?.[0]?.content?.parts?.[0]?.text || "I couldn't process that. Please try again!";

    res.json({ reply });
  } catch (err) {
    console.error('chatbot error:', err);
    res.status(500).json({ error: 'Failed to process chat query.' });
  }
});

// ─────────────────────────────────────────────────────────────
// CLASSROOM PARTICIPANT MAPPINGS
// ─────────────────────────────────────────────────────────────
app.post('/api/classroom/register-name', async (req, res) => {
  try {
    const { channelName, uid, name, role, handRaised, micAllowed, videoAllowed } = req.body;
    if (!channelName || !uid || !name) {
      return res.status(400).json({ error: 'channelName, uid, and name are required.' });
    }
    
    if (getIsConnected() && models.ClassroomName) {
      // 1. Delete duplicate old entries for the same name in this channel to clean up refreshes
      await models.ClassroomName.deleteMany({
        channelName,
        name,
        uid: { $ne: parseInt(uid, 10) }
      });

      const isTeacher = role === 'publisher';
      const updateFields = { name, role: role || 'student', updatedAt: new Date() };
      
      if (handRaised !== undefined) {
        updateFields.handRaised = handRaised;
      }
      
      if (isTeacher) {
        updateFields.micAllowed = true;
        updateFields.videoAllowed = true;
        updateFields.approved = true;
      } else {
        updateFields.approved = (req.body.approved !== undefined) ? req.body.approved : false;
        if (micAllowed !== undefined) {
          updateFields.micAllowed = micAllowed;
        }
        if (videoAllowed !== undefined) {
          updateFields.videoAllowed = videoAllowed;
        }
      }
      updateFields.kicked = (req.body.kicked !== undefined) ? req.body.kicked : false;
      updateFields.spotlight = (req.body.spotlight !== undefined) ? req.body.spotlight : false;
      
      await models.ClassroomName.findOneAndUpdate(
        { channelName, uid: parseInt(uid, 10) },
        updateFields,
        { upsert: true, new: true }
      );
    }
    res.json({ success: true });
  } catch (err) {
    console.error('register-name error:', err);
    res.status(500).json({ error: 'Failed to register name.' });
  }
});

app.post('/api/classroom/toggle-permission', async (req, res) => {
  try {
    const { channelName, uid, type, allowed } = req.body;
    if (!channelName || !uid || !type) {
      return res.status(400).json({ error: 'channelName, uid, and type are required.' });
    }
    
    if (getIsConnected() && models.ClassroomName) {
      const updateObj = {};
      if (type === 'mic') {
        updateObj.micAllowed = allowed;
      } else if (type === 'video') {
        updateObj.videoAllowed = allowed;
      }
      updateObj.updatedAt = new Date();
      
      await models.ClassroomName.findOneAndUpdate(
        { channelName, uid: parseInt(uid, 10) },
        { $set: updateObj }
      );
    }
    res.json({ success: true });
  } catch (err) {
    console.error('toggle-permission error:', err);
    res.status(500).json({ error: 'Failed to toggle permission.' });
  }
});

app.post('/api/classroom/heartbeat', async (req, res) => {
  try {
    const { channelName, uid } = req.body;
    if (!channelName || !uid) {
      return res.status(400).json({ error: 'channelName and uid are required.' });
    }
    if (getIsConnected() && models.ClassroomName) {
      await models.ClassroomName.findOneAndUpdate(
        { channelName, uid: parseInt(uid, 10) },
        { $set: { updatedAt: new Date() } }
      );
    }
    res.json({ success: true });
  } catch (err) {
    console.error('heartbeat error:', err);
    res.status(500).json({ error: 'Failed to update heartbeat.' });
  }
});

app.get('/api/classroom/names', async (req, res) => {
  try {
    const { channelName } = req.query;
    if (!channelName) {
      return res.status(400).json({ error: 'channelName is required.' });
    }
    
    let mappings = [];
    if (getIsConnected() && models.ClassroomName) {
      // Show only members active in the last 40 seconds (safe margin above 10s heartbeat)
      const activeThreshold = new Date(Date.now() - 40 * 1000);
      mappings = await models.ClassroomName.find({
        channelName,
        updatedAt: { $gte: activeThreshold }
      });
    }
    res.json({ mappings });
  } catch (err) {
    console.error('get-names error:', err);
    res.status(500).json({ error: 'Failed to retrieve names.' });
  }
});

app.post('/api/classroom/approve', async (req, res) => {
  try {
    const { channelName, uid } = req.body;
    if (!channelName || !uid) {
      return res.status(400).json({ error: 'channelName and uid are required.' });
    }

    if (getIsConnected() && models.ClassroomName) {
      await models.ClassroomName.findOneAndUpdate(
        { channelName, uid: parseInt(uid, 10) },
        { $set: { approved: true, updatedAt: new Date() } }
      );
    }
    res.json({ success: true });
  } catch (err) {
    console.error('approve error:', err);
    res.status(500).json({ error: 'Failed to approve user.' });
  }
});

app.post('/api/classroom/kick', async (req, res) => {
  try {
    const { channelName, uid } = req.body;
    if (!channelName || !uid) {
      return res.status(400).json({ error: 'channelName and uid are required.' });
    }

    if (getIsConnected() && models.ClassroomName) {
      await models.ClassroomName.findOneAndUpdate(
        { channelName, uid: parseInt(uid, 10) },
        { $set: { kicked: true, updatedAt: new Date() } }
      );
    }
    res.json({ success: true });
  } catch (err) {
    console.error('kick error:', err);
    res.status(500).json({ error: 'Failed to kick user.' });
  }
});

app.post('/api/classroom/spotlight', async (req, res) => {
  try {
    const { channelName, uid } = req.body;
    
    if (getIsConnected() && models.ClassroomName) {
      await models.ClassroomName.updateMany(
        { channelName },
        { $set: { spotlight: false } }
      );
      
      if (uid) {
        await models.ClassroomName.findOneAndUpdate(
          { channelName, uid: parseInt(uid, 10) },
          { $set: { spotlight: true, updatedAt: new Date() } }
        );
      }
    }
    res.json({ success: true });
  } catch (err) {
    console.error('spotlight error:', err);
    res.status(500).json({ error: 'Failed to spotlight user.' });
  }
});

// ─────────────────────────────────────────────────────────────
// CLASSROOM CHAT  (real-time synced chat — persisted in MongoDB)
// POST /api/classroom/chat   — send a message
// GET  /api/classroom/chat   — fetch last N messages (polling)
// ─────────────────────────────────────────────────────────────
app.post('/api/classroom/chat', async (req, res) => {
  try {
    const { channelName, sender, text, isTeacher } = req.body;
    if (!channelName || !sender || !text) {
      return res.status(400).json({ error: 'channelName, sender, and text are required.' });
    }

    // Sanitize text — strip HTML tags
    const safeText = String(text).replace(/<[^>]*>/g, '').trim().slice(0, 1000);
    const safeSender = String(sender).replace(/<[^>]*>/g, '').trim().slice(0, 100);

    if (!safeText) return res.status(400).json({ error: 'Message text is empty after sanitization.' });

    if (getIsConnected() && models.ClassroomChat) {
      await models.ClassroomChat.create({
        channelName,
        sender: safeSender,
        text: safeText,
        isTeacher: !!isTeacher
      });
    }
    res.json({ success: true });
  } catch (err) {
    console.error('chat send error:', err);
    res.status(500).json({ error: 'Failed to save chat message.' });
  }
});

app.get('/api/classroom/chat', async (req, res) => {
  try {
    const { channelName, since } = req.query;
    if (!channelName) {
      return res.status(400).json({ error: 'channelName is required.' });
    }

    let messages = [];
    if (getIsConnected() && models.ClassroomChat) {
      const query = { channelName };
      if (since) {
        query.createdAt = { $gt: new Date(since) };
      }
      messages = await models.ClassroomChat
        .find(query)
        .sort({ createdAt: 1 })
        .limit(200)
        .lean();
    }
    res.json({ messages });
  } catch (err) {
    console.error('chat fetch error:', err);
    res.status(500).json({ error: 'Failed to fetch chat messages.' });
  }
});

app.post('/api/classroom/transcript', async (req, res) => {
  try {
    const { channelName, sender, text } = req.body;
    if (!channelName || !sender || !text) {
      return res.status(400).json({ error: 'channelName, sender, and text are required.' });
    }

    if (getIsConnected() && models.ClassroomTranscript) {
      await models.ClassroomTranscript.create({ channelName, sender, text });
    }
    res.json({ success: true });
  } catch (err) {
    console.error('transcript error:', err);
    res.status(500).json({ error: 'Failed to record transcript.' });
  }
});

app.post('/api/classroom/summarize', async (req, res) => {
  try {
    const { channelName } = req.body;
    if (!channelName) {
      return res.status(400).json({ error: 'channelName is required.' });
    }

    if (getIsConnected() && models.ClassroomTranscript && models.ClassroomSummary) {
      const lines = await models.ClassroomTranscript.find({ channelName }).sort({ createdAt: 1 });
      if (lines.length === 0) {
        return res.json({ summary: "No lecture captions recorded yet to summarize." });
      }

      const fullTranscript = lines.map(l => `${l.sender}: ${l.text}`).join('\n');
      const apiKey = process.env.GEMINI_API_KEY;
      
      if (!apiKey) {
        const fallbackSummary = `### Classroom Lecture Summary (${channelName})\n\n**Key Topics:**\n- Live class session starting.\n\n*Note: Add GEMINI_API_KEY to your backend .env file to enable live AI summaries.*`;
        await models.ClassroomSummary.findOneAndUpdate(
          { channelName },
          { summary: fallbackSummary },
          { upsert: true, new: true }
        );
        return res.json({ summary: fallbackSummary });
      }

      const fetch = require('node-fetch');
      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [{
              text: `You are a Principal AI Classroom Summarizer. Review the following transcription script from a live online classroom session. Generate a structured markdown summary containing:
1. Key topics discussed
2. Chronological action items
3. Live Q&A log highlights

Transcript:
${fullTranscript}`
            }]
          }]
        })
      });

      const data = await response.json();
      let summary = "";
      if (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts[0]) {
        summary = data.candidates[0].content.parts[0].text;
      } else {
        throw new Error(JSON.stringify(data));
      }

      await models.ClassroomSummary.findOneAndUpdate(
        { channelName },
        { summary },
        { upsert: true, new: true }
      );

      res.json({ summary });
    } else {
      res.status(500).json({ error: 'Database connection offline.' });
    }
  } catch (err) {
    console.error('summarize error:', err);
    res.status(500).json({ error: 'Failed to generate classroom summary: ' + err.message });
  }
});

// ─────────────────────────────────────────────────────────────
// START
// ─────────────────────────────────────────────────────────────
app.listen(PORT, () => console.log(`✅  MPULSE backend running on port ${PORT}`));
