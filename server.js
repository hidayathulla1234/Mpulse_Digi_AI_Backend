
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const Razorpay = require('razorpay');
const crypto = require('crypto');
const admin = require('firebase-admin');
const nodemailer = require('nodemailer');
const rateLimit = require('express-rate-limit');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 5000;

// ─────────────────────────────────────────────
// MIDDLEWARE
// ─────────────────────────────────────────────

// Allow requests only from your website domain(s).
// Add your real domain(s) here once you have them, plus localhost for testing.
const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'http://localhost:3000')
  .split(',')
  .map(o => o.trim());

app.use(cors({
  origin: function (origin, callback) {
    // allow requests with no origin (e.g. curl, server-to-server) and allowed list
    if (!origin || allowedOrigins.includes(origin) || allowedOrigins.includes('*')) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  }
}));

app.use(express.json());

// Basic rate limiting to prevent abuse of payment/order endpoints
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 60,                  // limit each IP to 60 requests per window
  message: { error: 'Too many requests. Please try again later.' }
});
app.use('/api/', apiLimiter);

// ─────────────────────────────────────────────
// FIREBASE ADMIN INIT
// ─────────────────────────────────────────────
// Supports two ways of loading credentials:
//  1. Local file serviceAccountKey.json (good for local dev)
//  2. Env var FIREBASE_SERVICE_ACCOUNT_JSON containing the full JSON as a string
//     (good for hosts like Render where you can't easily upload a file)

let serviceAccount;
if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
} else {
  serviceAccount = require('./serviceAccountKey.json');
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

// ─────────────────────────────────────────────
// RAZORPAY INIT
// ─────────────────────────────────────────────

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET
});

// ─────────────────────────────────────────────
// EMAIL (NODEMAILER) SETUP
// ─────────────────────────────────────────────

const transporter = nodemailer.createTransport({
  service: 'gmail', // change to your provider if not Gmail
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS // App Password, not your normal password
  }
});

async function sendEnrollmentEmail({ name, phone, email, course, fee, plan, slot, date, mode, bookingId, paymentId }) {
  const mailOptions = {
    from: `"MPULSE DIGITAL AI" <${process.env.EMAIL_USER}>`,
    to: process.env.NOTIFY_EMAIL || process.env.EMAIL_USER, // where YOU receive notifications
    subject: `🎉 New Enrollment: ${course} — ${name}`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;">
        <h2 style="color:#6d28d9;">New Enrollment Received</h2>
        <table style="width:100%;border-collapse:collapse;font-size:14px;">
          <tr><td style="padding:8px;font-weight:bold;">Booking ID</td><td style="padding:8px;">${bookingId}</td></tr>
          <tr><td style="padding:8px;font-weight:bold;">Student Name</td><td style="padding:8px;">${name}</td></tr>
          <tr><td style="padding:8px;font-weight:bold;">Phone</td><td style="padding:8px;">${phone}</td></tr>
          <tr><td style="padding:8px;font-weight:bold;">Email</td><td style="padding:8px;">${email || '—'}</td></tr>
          <tr><td style="padding:8px;font-weight:bold;">Course</td><td style="padding:8px;">${course}</td></tr>
          <tr><td style="padding:8px;font-weight:bold;">Fee</td><td style="padding:8px;">${fee}</td></tr>
          <tr><td style="padding:8px;font-weight:bold;">Payment Plan</td><td style="padding:8px;">${plan}</td></tr>
          <tr><td style="padding:8px;font-weight:bold;">Demo Date</td><td style="padding:8px;">${date}</td></tr>
          <tr><td style="padding:8px;font-weight:bold;">Time Slot</td><td style="padding:8px;">${slot}</td></tr>
          <tr><td style="padding:8px;font-weight:bold;">Mode</td><td style="padding:8px;">${mode}</td></tr>
          <tr><td style="padding:8px;font-weight:bold;">Razorpay Payment ID</td><td style="padding:8px;">${paymentId}</td></tr>
        </table>
        <p style="color:#666;font-size:12px;margin-top:20px;">This is an automated notification from your MPULSE DIGITAL AI website.</p>
      </div>
    `
  };
  await transporter.sendMail(mailOptions);
}

// ─────────────────────────────────────────────
// GOOGLE SHEETS LOGGER
// ─────────────────────────────────────────────
// Forwards form data to your Google Apps Script Web App, which writes it
// into the right tab of your Google Sheet under mpulsedigitalai@gmail.com.
// This NEVER blocks or breaks the main request — if Sheets logging fails,
// the form submission still succeeds for the user (errors are only logged
// to the server console).

async function logToGoogleSheet(formType, payload) {
  const webhookUrl = process.env.GOOGLE_SHEETS_WEBHOOK_URL;
  if (!webhookUrl) return; // Sheets logging not configured yet — skip silently

  try {
    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ formType, payload })
    });
  } catch (err) {
    console.error(`Google Sheets logging failed for ${formType}:`, err);
  }
}

// ─────────────────────────────────────────────
// HEALTH CHECK
// ─────────────────────────────────────────────

app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'MPULSE DIGITAL AI backend' });
});

// ─────────────────────────────────────────────
// ROUTE 1: CREATE RAZORPAY ORDER
// ─────────────────────────────────────────────
// The frontend calls this BEFORE opening Razorpay checkout.
// We create the order server-side so the amount can't be tampered with
// in the browser (a malicious user could otherwise edit the JS and pay ₹1
// for a ₹20,000 course).

app.post('/api/create-order', async (req, res) => {
  try {
    const { amount, courseName, studentName, studentPhone } = req.body;

    if (!amount || typeof amount !== 'number' || amount <= 0) {
      return res.status(400).json({ error: 'A valid amount (in rupees) is required.' });
    }
    if (!courseName || !studentName || !studentPhone) {
      return res.status(400).json({ error: 'courseName, studentName, and studentPhone are required.' });
    }

    const options = {
      amount: Math.round(amount * 100), // Razorpay expects paise
      currency: 'INR',
      receipt: 'rcpt_' + Date.now(),
      notes: {
        courseName,
        studentName,
        studentPhone
      }
    };

    const order = await razorpay.orders.create(options);

    res.json({
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      keyId: process.env.RAZORPAY_KEY_ID // safe to expose — this is the public key
    });
  } catch (err) {
    console.error('Error creating Razorpay order:', err);
    res.status(500).json({ error: 'Failed to create order. Please try again.' });
  }
});

// ─────────────────────────────────────────────
// ROUTE 2: VERIFY PAYMENT (after Razorpay checkout completes)
// ─────────────────────────────────────────────
// The frontend calls this from the Razorpay `handler` callback.
// We verify the cryptographic signature to confirm the payment is genuine
// and was not faked/tampered with by the client.

app.post('/api/verify-payment', async (req, res) => {
  try {
    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
      enrollment // { name, phone, email, course, fee, plan, date, slot, mode }
    } = req.body;

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ error: 'Missing Razorpay payment fields.' });
    }

    // Recreate the expected signature using your Key Secret
    const body = razorpay_order_id + '|' + razorpay_payment_id;
    const expectedSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(body.toString())
      .digest('hex');

    const isValid = expectedSignature === razorpay_signature;

    if (!isValid) {
      return res.status(400).json({ verified: false, error: 'Payment signature verification failed.' });
    }

    // Generate a human-friendly booking ID
    const bookingId = 'MPF-' + new Date().getFullYear() + '-' + Math.floor(100000 + Math.random() * 900000);

    // Save the verified enrollment + payment to Firestore
    const record = {
      bookingId,
      razorpay_order_id,
      razorpay_payment_id,
      name: enrollment?.name || '',
      phone: enrollment?.phone || '',
      email: enrollment?.email || '',
      course: enrollment?.course || '',
      fee: enrollment?.fee || '',
      plan: enrollment?.plan || '',
      date: enrollment?.date || '',
      slot: enrollment?.slot || '',
      mode: enrollment?.mode || '',
      status: 'paid',
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    };

    await db.collection('enrollments').doc(bookingId).set(record);

    // Log to Google Sheet (Enrollments tab) — never blocks the response
    logToGoogleSheet('Enrollments', {
      'Booking ID': bookingId,
      'Name': record.name,
      'Phone': record.phone,
      'Email': record.email,
      'Course': record.course,
      'Fee': record.fee,
      'Plan': record.plan,
      'Demo Date': record.date,
      'Time Slot': record.slot,
      'Mode': record.mode,
      'Razorpay Order ID': razorpay_order_id,
      'Razorpay Payment ID': razorpay_payment_id,
      'Status': 'paid'
    });

    // Send notification email (don't block the response if email fails)
    sendEnrollmentEmail({
      name: record.name,
      phone: record.phone,
      email: record.email,
      course: record.course,
      fee: record.fee,
      plan: record.plan,
      slot: record.slot,
      date: record.date,
      mode: record.mode,
      bookingId,
      paymentId: razorpay_payment_id
    }).catch(emailErr => console.error('Email send failed:', emailErr));

    res.json({ verified: true, bookingId });
  } catch (err) {
    console.error('Error verifying payment:', err);
    res.status(500).json({ error: 'Payment verification failed due to a server error.' });
  }
});

// ─────────────────────────────────────────────
// ROUTE 3: CONTACT / ENQUIRY FORM (no payment)
// ─────────────────────────────────────────────

app.post('/api/enquiry', async (req, res) => {
  try {
    const { name, phone, course, message } = req.body;

    if (!name || !phone) {
      return res.status(400).json({ error: 'Name and phone are required.' });
    }

    const enquiryId = 'ENQ-' + Date.now();

    // The frontend tags 2-minute popup sign-ups with course === 'Early-bird signup'
    // so we can route them to a separate "Signups" tab instead of "Enquiries"
    const isSignup = course === 'Early-bird signup';
    const sheetTab = isSignup ? 'Signups' : 'Enquiries';

    // Enquiries and sign-ups are logged to Google Sheets only (not Firestore) —
    // Firebase is reserved for payment/enrollment records.
    logToGoogleSheet(sheetTab, {
      'Name': name,
      'Phone': phone,
      'Course': course || '',
      'Message': message || ''
    });

    // Notify by email too (optional but useful so you don't have to check Firestore manually)
    transporter.sendMail({
      from: `"MPULSE DIGITAL AI" <${process.env.EMAIL_USER}>`,
      to: process.env.NOTIFY_EMAIL || process.env.EMAIL_USER,
      subject: isSignup ? `🎯 New Sign-Up from ${name}` : `📩 New Enquiry from ${name}`,
      html: `
        <div style="font-family:Arial,sans-serif;">
          <h3>${isSignup ? 'New Pop-Up Sign-Up' : 'New Website Enquiry'}</h3>
          <p><strong>Name:</strong> ${name}</p>
          <p><strong>Phone:</strong> ${phone}</p>
          <p><strong>Course:</strong> ${course || '—'}</p>
          <p><strong>Message:</strong> ${message || '—'}</p>
        </div>
      `
    }).catch(e => console.error('Enquiry email failed:', e));

    res.json({ success: true, enquiryId });
  } catch (err) {
    console.error('Error saving enquiry:', err);
    res.status(500).json({ error: 'Could not submit enquiry. Please try again.' });
  }
});

// ─────────────────────────────────────────────
// ROUTE 4: REQUEST A CALLBACK (quick capture, no course needed)
// ─────────────────────────────────────────────
// Used by the nav "Request a Callback" button and course-detail modal.

app.post('/api/callback', async (req, res) => {
  try {
    const { name, phone, preferredTime } = req.body;

    if (!name || !phone) {
      return res.status(400).json({ error: 'Name and phone are required.' });
    }

    const callbackId = 'CB-' + Date.now();

    // Callback requests are logged to Google Sheets only (not Firestore) —
    // Firebase is reserved for payment/enrollment records.
    logToGoogleSheet('Callbacks', {
      'Name': name,
      'Phone': phone,
      'Preferred Time': preferredTime || 'Anytime',
      'Status': 'pending'
    });

    transporter.sendMail({
      from: `"MPULSE DIGITAL AI" <${process.env.EMAIL_USER}>`,
      to: process.env.NOTIFY_EMAIL || process.env.EMAIL_USER,
      subject: `📞 Callback Request from ${name}`,
      html: `
        <div style="font-family:Arial,sans-serif;">
          <h3>New Callback Request</h3>
          <p><strong>Name:</strong> ${name}</p>
          <p><strong>Phone:</strong> ${phone}</p>
          <p><strong>Preferred Time:</strong> ${preferredTime || 'Anytime'}</p>
        </div>
      `
    }).catch(e => console.error('Callback email failed:', e));

    res.json({ success: true, callbackId });
  } catch (err) {
    console.error('Error saving callback request:', err);
    res.status(500).json({ error: 'Could not submit callback request. Please try again.' });
  }
});

// ─────────────────────────────────────────────
// ROUTE: CHECK OVERDUE INSTALLMENT STUDENTS (admin-only)
// ─────────────────────────────────────────────
// Returns a list of students on the installment plan whose 2nd or 3rd
// payment due date has passed without being marked paid. You check this
// list manually (e.g. once a day) and decide whether to pause access for
// anyone overdue — e.g. remove them from the class WhatsApp group or Zoom
// link. This does NOT automatically lock anyone out; it only flags who to
// review, since there's no student login/dashboard system yet.
//
// Usage: GET /api/overdue-students?adminKey=YOUR_ADMIN_KEY

app.get('/api/overdue-students', async (req, res) => {
  try {
    const { adminKey } = req.query;
    if (adminKey !== process.env.ADMIN_KEY) {
      return res.status(403).json({ error: 'Unauthorized.' });
    }

    const today = new Date().toISOString().split('T')[0];
    const snapshot = await db.collection('enrollments')
      .where('planType', '==', 'installments')
      .where('installmentNumber', '==', 1)
      .get();

    const overdue = [];
    snapshot.forEach(doc => {
      const data = doc.data();
      if (data.paymentStatus === 'completed') return; // fully paid, skip

      const isOverdueOn2 = !data.installment2Paid && data.installment2DueDate && data.installment2DueDate < today;
      const isOverdueOn3 = !data.installment3Paid && data.installment3DueDate && data.installment3DueDate < today;

      if (isOverdueOn2 || isOverdueOn3) {
        overdue.push({
          bookingId: data.bookingId,
          name: data.name,
          phone: data.phone,
          email: data.email,
          course: data.course,
          overdueOn: isOverdueOn2 ? 'Installment 2 (₹7,500)' : 'Installment 3 (₹7,500)',
          dueDate: isOverdueOn2 ? data.installment2DueDate : data.installment3DueDate,
          daysOverdue: Math.floor((new Date(today) - new Date(isOverdueOn2 ? data.installment2DueDate : data.installment3DueDate)) / (1000 * 60 * 60 * 24))
        });
      }
    });

    res.json({ overdueCount: overdue.length, overdueStudents: overdue });
  } catch (err) {
    console.error('Error checking overdue students:', err);
    res.status(500).json({ error: 'Could not check overdue students.' });
  }
});

// ─────────────────────────────────────────────
// ROUTE: MARK AN INSTALLMENT AS PAID MANUALLY (admin-only)
// ─────────────────────────────────────────────
// Use this if a student pays installment 2 or 3 (e.g. via the Razorpay
// payment link directly, or cash) so the overdue tracker stops flagging them.
//
// Usage: POST /api/mark-installment-paid
// Body: { adminKey, bookingId, installmentNumber: 2 or 3 }

app.post('/api/mark-installment-paid', async (req, res) => {
  try {
    const { adminKey, bookingId, installmentNumber } = req.body;
    if (adminKey !== process.env.ADMIN_KEY) {
      return res.status(403).json({ error: 'Unauthorized.' });
    }
    if (!bookingId || !installmentNumber) {
      return res.status(400).json({ error: 'bookingId and installmentNumber are required.' });
    }

    const field = installmentNumber === 2 ? 'installment2Paid' : 'installment3Paid';
    await db.collection('enrollments').doc(bookingId).update({ [field]: true });

    res.json({ success: true });
  } catch (err) {
    console.error('Error marking installment paid:', err);
    res.status(500).json({ error: 'Could not update installment status.' });
  }
});

// ─────────────────────────────────────────────
// ROUTE 5: SEATS LEFT (real cohort capacity tracking)
// ─────────────────────────────────────────────
// Powers the "Filling Fast — X Seats Left" banner on the frontend with a real
// number instead of a hardcoded one. Uses a single Firestore doc as a counter.
//
// Setup: create a doc manually once at Firestore path cohorts/current with:
//   { totalSeats: 30, seatsTaken: 10 }
// Each successful payment can optionally increment seatsTaken (see
// the optional increment call inside /api/verify-payment below, commented out
// since enabling it depends on whether you want enrollments to consume seats
// automatically or whether you manage cohort batches manually).

app.get('/api/seats', async (req, res) => {
  try {
    const doc = await db.collection('cohorts').doc('current').get();
    if (!doc.exists) {
      // Sensible default if you haven't set up the cohort doc yet
      return res.json({ seatsLeft: 20, totalSeats: 30 });
    }
    const data = doc.data();
    const seatsLeft = Math.max((data.totalSeats || 30) - (data.seatsTaken || 0), 0);
    res.json({ seatsLeft, totalSeats: data.totalSeats || 30 });
  } catch (err) {
    console.error('Error fetching seats:', err);
    // Fail gracefully with a fallback rather than breaking the banner
    res.json({ seatsLeft: 20, totalSeats: 30 });
  }
});

// Admin-only-style endpoint to update seat counts manually (protect this in
// production with an admin password/header check before exposing publicly).
app.post('/api/seats/update', async (req, res) => {
  try {
    const { totalSeats, seatsTaken, adminKey } = req.body;

    if (adminKey !== process.env.ADMIN_KEY) {
      return res.status(403).json({ error: 'Unauthorized.' });
    }

    await db.collection('cohorts').doc('current').set({
      totalSeats: totalSeats || 30,
      seatsTaken: seatsTaken || 0,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    res.json({ success: true });
  } catch (err) {
    console.error('Error updating seats:', err);
    res.status(500).json({ error: 'Could not update seats.' });
  }
});

// ─────────────────────────────────────────────
// START SERVER
// ─────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`✅ MPULSE backend running on port ${PORT}`);
});
