require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const Razorpay   = require('razorpay');
const crypto     = require('crypto');
const admin      = require('firebase-admin');
const nodemailer = require('nodemailer');
const rateLimit  = require('express-rate-limit');
const fetch      = require('node-fetch');

const app  = express();
const PORT = process.env.PORT || 5000;
app.set('trust proxy', 1);

// ─────────────────────────────────────────────────────────────
// MIDDLEWARE
// ─────────────────────────────────────────────────────────────
const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'http://localhost:3000')
  .split(',').map(o => o.trim());

app.use(cors({
  origin(origin, cb) {
    if (!origin || allowedOrigins.includes(origin) || allowedOrigins.includes('*'))
      cb(null, true);
    else
      cb(new Error('Not allowed by CORS'));
  }
}));
app.use(express.json());
app.use('/api/', rateLimit({ windowMs: 15 * 60 * 1000, max: 60, message: { error: 'Too many requests. Try again later.' } }));

// ─────────────────────────────────────────────────────────────
// FIREBASE
// ─────────────────────────────────────────────────────────────
const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT_JSON
  ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)
  : require('./serviceAccountKey.json');

admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

// ─────────────────────────────────────────────────────────────
// RAZORPAY
// ─────────────────────────────────────────────────────────────
const razorpay = new Razorpay({
  key_id:     process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET
});

// ─────────────────────────────────────────────────────────────
// EMAIL  (Gmail — mpulsedigitalai@gmail.com)
// ─────────────────────────────────────────────────────────────
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
});

function sendEmail(subject, html) {
  transporter.sendMail({
    from: `"MPULSE DIGITAL AI" <${process.env.EMAIL_USER}>`,
    to:   process.env.NOTIFY_EMAIL || 'mpulsedigitalai@gmail.com',
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
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ formType, payload })
    });
  } catch (err) { console.error('Sheets log error:', err.message); }
}

// ─────────────────────────────────────────────────────────────
// FIRESTORE HELPER
// ─────────────────────────────────────────────────────────────
async function saveDoc(collection, docId, data) {
  try {
    await db.collection(collection).doc(docId).set({
      ...data,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
  } catch (err) { console.error(`Firestore save error (${collection}):`, err.message); }
}

// ─────────────────────────────────────────────────────────────
// PAYMENT PLAN CONFIG
//
//  One-time:      ₹28,000  (student saves ₹2,000 off ₹30,000)
//  Installment 1: ₹15,000  (due at enrollment)
//  Installment 2: ₹15,000  (due 1 month after enrollment)
//  Total via EMI: ₹30,000
// ─────────────────────────────────────────────────────────────
const PRICE_ONE_TIME    = 28000;
const PRICE_INSTALLMENT = 15000;   // each of 2 installments
const PRICE_FULL        = 30000;   // total if paying by EMI

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
    oneTime:      { amount: PRICE_ONE_TIME,    label: 'Pay in Full — ₹28,000 (save ₹2,000)' },
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

    const order = await razorpay.orders.create({
      amount:   plan.amount * 100,   // paise
      currency: 'INR',
      receipt:  'rcpt_' + Date.now(),
      notes:    { courseName, studentName, studentPhone, planType, installmentNumber: installmentNumber || '' }
    });

    res.json({
      orderId:   order.id,
      amount:    order.amount,
      currency:  order.currency,
      keyId:     process.env.RAZORPAY_KEY_ID,
      planLabel: plan.label
    });
  } catch (err) {
    console.error('create-order error:', err);
    res.status(500).json({ error: 'Failed to create Razorpay order.' });
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

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature)
      return res.status(400).json({ error: 'Missing Razorpay payment fields.' });

    // ── Signature verification ──
    const expected = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest('hex');

    if (expected !== razorpay_signature)
      return res.status(400).json({ verified: false, error: 'Payment signature mismatch.' });

    const plan      = getPlan(planType, installmentNumber);
    const bookingId = genId('MPF');
    const today     = new Date().toISOString().split('T')[0];

    const record = {
      bookingId,
      razorpay_order_id,
      razorpay_payment_id,
      name:              enrollment?.name    || '',
      phone:             enrollment?.phone   || '',
      email:             enrollment?.email   || '',
      status:            enrollment?.status  || '',
      course:            enrollment?.course  || '',
      message:           enrollment?.message || '',
      planType:          planType            || '',
      installmentNumber: installmentNumber   || '',
      planLabel:         plan ? plan.label   : '',
      amountPaid:        plan ? plan.amount  : 0,
      date:              enrollment?.date    || '',
      slot:              enrollment?.slot    || '',
      mode:              enrollment?.mode    || '',
      type:              'enrollment',
      paymentStatus:     'paid'
    };

    // Track installment 2 due date when installment 1 is paid
    if (planType === 'installments' && parseInt(installmentNumber, 10) === 1) {
      record.installment2DueDate = addOneMonth(today);
      record.installment2Paid    = false;
      record.paymentStatus       = 'installment_1_paid';
    }
    if (planType === 'installments' && parseInt(installmentNumber, 10) === 2) {
      record.paymentStatus = 'fully_paid';
    }

    // ── Save to Firestore ──
    await saveDoc('enrollments', bookingId, record);

    // ── Log to Google Sheets ──
    await logToSheets('Enrollments', {
      'Booking ID':           bookingId,
      'Name':                 record.name,
      'Phone':                record.phone,
      'Email':                record.email,
      'Student Status':       record.status,
      'Course':               record.course,
      'Message':              record.message,
      'Plan Type':            record.planType,
      'Installment #':        record.installmentNumber,
      'Plan Label':           record.planLabel,
      'Amount Paid (₹)':      record.amountPaid,
      'Demo Date':            record.date,
      'Time Slot':            record.slot,
      'Mode':                 record.mode,
      'Razorpay Order ID':    razorpay_order_id,
      'Razorpay Payment ID':  razorpay_payment_id,
      'Payment Status':       record.paymentStatus,
      'Inst. 2 Due Date':     record.installment2DueDate || ''
    });

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

    res.json({ verified: true, bookingId, amountPaid: record.amountPaid, planLabel: record.planLabel });
  } catch (err) {
    console.error('verify-payment error:', err);
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
      email:   email   || '',
      status:  status  || '',
      course:  course  || '',
      date:    date    || '',
      slot:    slot    || '',
      mode:    mode    || '',
      message: message || '',
      type:    'demo_booking',
      paymentStatus: 'free_demo'
    };

    // ── Save to Firestore ──
    await saveDoc('demo_bookings', bookingId, record);

    // ── Log to Google Sheets ──
    await logToSheets('Demo Bookings', {
      'Booking ID':     bookingId,
      'Name':           record.name,
      'Phone':          record.phone,
      'Email':          record.email,
      'Student Status': record.status,
      'Course':         record.course,
      'Demo Date':      record.date,
      'Time Slot':      record.slot,
      'Mode':           record.mode,
      'Message':        record.message
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

    const today    = new Date().toISOString().split('T')[0];
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
          bookingId:   d.bookingId,
          name:        d.name,
          phone:       d.phone,
          email:       d.email,
          course:      d.course,
          overdueOn:   'Installment 2 — ₹15,000',
          dueDate:     d.installment2DueDate,
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

    await db.collection('enrollments').doc(bookingId).update({
      installment2Paid: true,
      paymentStatus:    'fully_paid'
    });

    res.json({ success: true });
  } catch (err) {
    console.error('mark-installment-paid error:', err);
    res.status(500).json({ error: 'Could not update installment status.' });
  }
});

// ─────────────────────────────────────────────────────────────
// START
// ─────────────────────────────────────────────────────────────
app.listen(PORT, () => console.log(`✅  MPULSE backend running on port ${PORT}`));
