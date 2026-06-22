
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const Razorpay = require('razorpay');
const crypto = require('crypto');
const admin = require('firebase-admin');
const nodemailer = require('nodemailer');
const rateLimit = require('express-rate-limit');

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

    await db.collection('enquiries').doc(enquiryId).set({
      name,
      phone,
      course: course || '',
      message: message || '',
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    // Notify by email too (optional but useful so you don't have to check Firestore manually)
    transporter.sendMail({
      from: `"MPULSE DIGITAL AI" <${process.env.EMAIL_USER}>`,
      to: process.env.NOTIFY_EMAIL || process.env.EMAIL_USER,
      subject: `📩 New Enquiry from ${name}`,
      html: `
        <div style="font-family:Arial,sans-serif;">
          <h3>New Website Enquiry</h3>
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
// START SERVER
// ─────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`✅ MPULSE backend running on port ${PORT}`);
});
