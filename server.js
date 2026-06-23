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

const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'http://localhost:3000')
  .split(',')
  .map(o => o.trim());

app.use(cors({
  origin: function (origin, callback) {
    if (!origin || allowedOrigins.includes(origin) || allowedOrigins.includes('*')) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  }
}));

app.use(express.json());
app.set('trust proxy', 1);

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  message: { error: 'Too many requests. Please try again later.' }
});
app.use('/api/', apiLimiter);

// ─────────────────────────────────────────────
// FIREBASE ADMIN INIT
// ─────────────────────────────────────────────

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
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

// ─────────────────────────────────────────────
// SEND ENROLLMENT EMAIL
// ─────────────────────────────────────────────

async function sendEnrollmentEmail({ name, phone, email, course, fee, plan, slot, date, mode, bookingId, paymentId }) {
  const mailOptions = {
    from: `"MPULSE DIGITAL AI" <${process.env.EMAIL_USER}>`,
    to: process.env.NOTIFY_EMAIL || process.env.EMAIL_USER,
    subject: `🎉 New Enrollment: ${course} — ${name}`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;background:#f9f9f9;padding:20px;border-radius:8px;">
        <h2 style="color:#6d28d9;">✅ New Enrollment Received</h2>
        <table style="width:100%;border-collapse:collapse;font-size:14px;background:white;border-radius:4px;">
          <tr style="border-bottom:1px solid #eee;"><td style="padding:10px;font-weight:bold;color:#333;">Booking ID</td><td style="padding:10px;color:#666;">${bookingId}</td></tr>
          <tr style="border-bottom:1px solid #eee;"><td style="padding:10px;font-weight:bold;color:#333;">Student Name</td><td style="padding:10px;color:#666;">${name}</td></tr>
          <tr style="border-bottom:1px solid #eee;"><td style="padding:10px;font-weight:bold;color:#333;">Phone</td><td style="padding:10px;color:#666;">${phone}</td></tr>
          <tr style="border-bottom:1px solid #eee;"><td style="padding:10px;font-weight:bold;color:#333;">Email</td><td style="padding:10px;color:#666;">${email || '—'}</td></tr>
          <tr style="border-bottom:1px solid #eee;"><td style="padding:10px;font-weight:bold;color:#333;">Course</td><td style="padding:10px;color:#666;">${course}</td></tr>
          <tr style="border-bottom:1px solid #eee;"><td style="padding:10px;font-weight:bold;color:#333;">Fee</td><td style="padding:10px;color:#666;">₹${fee}</td></tr>
          <tr style="border-bottom:1px solid #eee;"><td style="padding:10px;font-weight:bold;color:#333;">Payment Plan</td><td style="padding:10px;color:#666;">${plan}</td></tr>
          <tr style="border-bottom:1px solid #eee;"><td style="padding:10px;font-weight:bold;color:#333;">Demo Date</td><td style="padding:10px;color:#666;">${date}</td></tr>
          <tr style="border-bottom:1px solid #eee;"><td style="padding:10px;font-weight:bold;color:#333;">Time Slot</td><td style="padding:10px;color:#666;">${slot}</td></tr>
          <tr style="border-bottom:1px solid #eee;"><td style="padding:10px;font-weight:bold;color:#333;">Mode</td><td style="padding:10px;color:#666;">${mode}</td></tr>
          <tr><td style="padding:10px;font-weight:bold;color:#333;">Payment ID</td><td style="padding:10px;color:#666;">${paymentId}</td></tr>
        </table>
        <p style="color:#999;font-size:12px;margin-top:20px;text-align:center;">This is an automated notification from MPULSE DIGITAL AI</p>
      </div>
    `
  };
  await transporter.sendMail(mailOptions);
}

// ─────────────────────────────────────────────
// GOOGLE SHEETS LOGGER
// ─────────────────────────────────────────────

async function logToGoogleSheet(formType, payload) {
  const webhookUrl = process.env.GOOGLE_SHEETS_WEBHOOK_URL;
  if (!webhookUrl) {
    console.warn('Google Sheets webhook URL not configured');
    return;
  }

  try {
    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ formType, payload })
    });
    console.log(`✅ Logged to Google Sheets: ${formType}`);
  } catch (err) {
    console.error(`❌ Google Sheets logging failed for ${formType}:`, err.message);
  }
}

// ─────────────────────────────────────────────
// HEALTH CHECK
// ─────────────────────────────────────────────

app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'MPULSE DIGITAL AI backend', timestamp: new Date() });
});

// ─────────────────────────────────────────────
// ROUTE 1: CREATE RAZORPAY ORDER
// ─────────────────────────────────────────────

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
      amount: Math.round(amount * 100),
      currency: 'INR',
      receipt: 'rcpt_' + Date.now(),
      notes: { courseName, studentName, studentPhone }
    };

    const order = await razorpay.orders.create(options);

    res.json({
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      keyId: process.env.RAZORPAY_KEY_ID
    });
  } catch (err) {
    console.error('Error creating Razorpay order:', err);
    res.status(500).json({ error: 'Failed to create order. Please try again.' });
  }
});

// ─────────────────────────────────────────────
// ROUTE 2: VERIFY PAYMENT
// ─────────────────────────────────────────────

app.post('/api/verify-payment', async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, enrollment } = req.body;

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ error: 'Missing Razorpay payment fields.' });
    }

    const body = razorpay_order_id + '|' + razorpay_payment_id;
    const expectedSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(body.toString())
      .digest('hex');

    const isValid = expectedSignature === razorpay_signature;

    if (!isValid) {
      return res.status(400).json({ verified: false, error: 'Payment signature verification failed.' });
    }

    const bookingId = 'MPF-' + new Date().getFullYear() + '-' + Math.floor(100000 + Math.random() * 900000);

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

    // Save to Firebase (payment records)
    await db.collection('enrollments').doc(bookingId).set(record);

    // Log to Google Sheets
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

    // Send email
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
// ROUTE 3: ENQUIRY / CONTACT FORM
// ─────────────────────────────────────────────

app.post('/api/enquiry', async (req, res) => {
  try {
    const { name, phone, course, message } = req.body;

    if (!name || !phone) {
      return res.status(400).json({ error: 'Name and phone are required.' });
    }

    // Log to Google Sheets
    logToGoogleSheet('Enquiries', {
      'Name': name,
      'Phone': phone,
      'Course': course || '',
      'Message': message || ''
    });

    // Send email
    transporter.sendMail({
      from: `"MPULSE DIGITAL AI" <${process.env.EMAIL_USER}>`,
      to: process.env.NOTIFY_EMAIL || process.env.EMAIL_USER,
      subject: `📩 New Enquiry from ${name}`,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;background:#f9f9f9;padding:20px;border-radius:8px;">
          <h2 style="color:#6d28d9;">📩 New Website Enquiry</h2>
          <table style="width:100%;border-collapse:collapse;font-size:14px;background:white;">
            <tr style="border-bottom:1px solid #eee;"><td style="padding:10px;font-weight:bold;">Name</td><td style="padding:10px;">${name}</td></tr>
            <tr style="border-bottom:1px solid #eee;"><td style="padding:10px;font-weight:bold;">Phone</td><td style="padding:10px;">${phone}</td></tr>
            <tr style="border-bottom:1px solid #eee;"><td style="padding:10px;font-weight:bold;">Course</td><td style="padding:10px;">${course || '—'}</td></tr>
            <tr><td style="padding:10px;font-weight:bold;">Message</td><td style="padding:10px;">${message || '—'}</td></tr>
          </table>
        </div>
      `
    }).catch(e => console.error('Enquiry email failed:', e));

    res.json({ success: true });
  } catch (err) {
    console.error('Error saving enquiry:', err);
    res.status(500).json({ error: 'Could not submit enquiry. Please try again.' });
  }
});

// ─────────────────────────────────────────────
// ROUTE 4: REQUEST A CALLBACK
// ─────────────────────────────────────────────

app.post('/api/callback', async (req, res) => {
  try {
    const { name, phone, preferredTime } = req.body;

    if (!name || !phone) {
      return res.status(400).json({ error: 'Name and phone are required.' });
    }

    // Log to Google Sheets
    logToGoogleSheet('Callbacks', {
      'Name': name,
      'Phone': phone,
      'Preferred Time': preferredTime || 'Anytime',
      'Status': 'pending'
    });

    // Send email
    transporter.sendMail({
      from: `"MPULSE DIGITAL AI" <${process.env.EMAIL_USER}>`,
      to: process.env.NOTIFY_EMAIL || process.env.EMAIL_USER,
      subject: `📞 Callback Request from ${name}`,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;background:#f9f9f9;padding:20px;border-radius:8px;">
          <h2 style="color:#6d28d9;">📞 New Callback Request</h2>
          <table style="width:100%;border-collapse:collapse;font-size:14px;background:white;">
            <tr style="border-bottom:1px solid #eee;"><td style="padding:10px;font-weight:bold;">Name</td><td style="padding:10px;">${name}</td></tr>
            <tr style="border-bottom:1px solid #eee;"><td style="padding:10px;font-weight:bold;">Phone</td><td style="padding:10px;">${phone}</td></tr>
            <tr><td style="padding:10px;font-weight:bold;">Preferred Time</td><td style="padding:10px;">${preferredTime || 'Anytime'}</td></tr>
          </table>
        </div>
      `
    }).catch(e => console.error('Callback email failed:', e));

    res.json({ success: true });
  } catch (err) {
    console.error('Error saving callback request:', err);
    res.status(500).json({ error: 'Could not submit callback request. Please try again.' });
  }
});

// ─────────────────────────────────────────────
// ROUTE 5: SIGN-UP / POPUP (Early Bird)
// ─────────────────────────────────────────────

app.post('/api/signup', async (req, res) => {
  try {
    const { name, phone, email } = req.body;

    if (!name || !phone) {
      return res.status(400).json({ error: 'Name and phone are required.' });
    }

    // Log to Google Sheets
    logToGoogleSheet('Signups', {
      'Name': name,
      'Phone': phone,
      'Email': email || '',
      'Type': 'Early-bird popup'
    });

    // Send email
    transporter.sendMail({
      from: `"MPULSE DIGITAL AI" <${process.env.EMAIL_USER}>`,
      to: process.env.NOTIFY_EMAIL || process.env.EMAIL_USER,
      subject: `🎯 New Sign-Up from ${name}`,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;background:#f9f9f9;padding:20px;border-radius:8px;">
          <h2 style="color:#6d28d9;">🎯 New Early-Bird Sign-Up</h2>
          <table style="width:100%;border-collapse:collapse;font-size:14px;background:white;">
            <tr style="border-bottom:1px solid #eee;"><td style="padding:10px;font-weight:bold;">Name</td><td style="padding:10px;">${name}</td></tr>
            <tr style="border-bottom:1px solid #eee;"><td style="padding:10px;font-weight:bold;">Phone</td><td style="padding:10px;">${phone}</td></tr>
            <tr><td style="padding:10px;font-weight:bold;">Email</td><td style="padding:10px;">${email || '—'}</td></tr>
          </table>
        </div>
      `
    }).catch(e => console.error('Signup email failed:', e));

    res.json({ success: true });
  } catch (err) {
    console.error('Error saving signup:', err);
    res.status(500).json({ error: 'Could not submit signup. Please try again.' });
  }
});

// ─────────────────────────────────────────────
// START SERVER
// ─────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`✅ MPULSE DIGITAL AI backend running on port ${PORT}`);
  console.log(`📧 Emails will be sent to: ${process.env.NOTIFY_EMAIL || process.env.EMAIL_USER}`);
});
