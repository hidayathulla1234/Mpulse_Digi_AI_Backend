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
// RAZORPAY INIT (used only for payments)
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

function sendNotificationEmail(subject, htmlBody) {
  transporter.sendMail({
    from: `"MPULSE DIGITAL AI" <${process.env.EMAIL_USER}>`,
    to: process.env.NOTIFY_EMAIL || 'mpulsedigitalai@gmail.com',
    subject,
    html: htmlBody
  }).catch(err => console.error('Email send failed:', err));
}

// ─────────────────────────────────────────────
// GOOGLE SHEETS LOGGER
// ─────────────────────────────────────────────
async function logToGoogleSheet(formType, payload) {
  const webhookUrl = process.env.GOOGLE_SHEETS_WEBHOOK_URL;
  if (!webhookUrl) return;

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
// FIRESTORE LOGGER (generic, used by all 4 forms)
// ─────────────────────────────────────────────
async function saveToFirestore(collectionName, docId, data) {
  try {
    await db.collection(collectionName).doc(docId).set({
      ...data,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
  } catch (err) {
    console.error(`Firestore save failed for ${collectionName}:`, err);
  }
}

// ─────────────────────────────────────────────
// PAYMENT PLAN CALCULATOR
// ─────────────────────────────────────────────
const COURSE_BASE_PRICE = 30000;
const ONE_TIME_DISCOUNT = 3000;

function getPaymentPlanDetails(planType, installmentNumber) {
  if (planType === 'one-time') {
    return { amount: COURSE_BASE_PRICE - ONE_TIME_DISCOUNT, label: 'One-Time Payment (₹3,000 discount applied)' };
  }
  if (planType === 'installments') {
    const num = parseInt(installmentNumber, 10);
    if (num === 1) return { amount: Math.round(COURSE_BASE_PRICE * 0.5), label: 'Installment 1 of 3 (50%)' };
    if (num === 2) return { amount: Math.round(COURSE_BASE_PRICE * 0.25), label: 'Installment 2 of 3 (25%) — due 20 days after enrollment' };
    if (num === 3) return { amount: Math.round(COURSE_BASE_PRICE * 0.25), label: 'Installment 3 of 3 (25%) — due 40 days after enrollment' };
  }
  return null;
}

// ─────────────────────────────────────────────
// OVERDUE TRACKING (for installment plans only)
// ─────────────────────────────────────────────
function calculateDueDates(enrollmentDate) {
  const base = new Date(enrollmentDate);
  const due2 = new Date(base); due2.setDate(due2.getDate() + 20);
  const due3 = new Date(base); due3.setDate(due3.getDate() + 40);
  return {
    installment2DueDate: due2.toISOString().split('T')[0],
    installment3DueDate: due3.toISOString().split('T')[0]
  };
}

// ─────────────────────────────────────────────
// HEALTH CHECK
// ─────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'MPULSE DIGITAL AI backend' });
});

// ─────────────────────────────────────────────
// ROUTE: GET PAYMENT PLAN OPTIONS
// ─────────────────────────────────────────────
app.get('/api/payment-plans', (req, res) => {
  res.json({
    basePrice: COURSE_BASE_PRICE,
    oneTime: {
      amount: COURSE_BASE_PRICE - ONE_TIME_DISCOUNT,
      discount: ONE_TIME_DISCOUNT,
      label: 'Pay in Full — Save ₹3,000'
    },
    installments: {
      totalAmount: COURSE_BASE_PRICE,
      schedule: [
        { number: 1, percent: 50, amount: Math.round(COURSE_BASE_PRICE * 0.5), dueLabel: 'Due at enrollment' },
        { number: 2, percent: 25, amount: Math.round(COURSE_BASE_PRICE * 0.25), dueLabel: 'Due 20 days after enrollment' },
        { number: 3, percent: 25, amount: Math.round(COURSE_BASE_PRICE * 0.25), dueLabel: 'Due 40 days after enrollment' }
      ]
    }
  });
});

// ─────────────────────────────────────────────
// ROUTE: CREATE RAZORPAY ORDER (payment only)
// ─────────────────────────────────────────────
app.post('/api/create-order', async (req, res) => {
  try {
    const { planType, installmentNumber, courseName, studentName, studentPhone, enrollmentId } = req.body;

    if (!planType || !courseName || !studentName || !studentPhone) {
      return res.status(400).json({ error: 'planType, courseName, studentName, and studentPhone are required.' });
    }

    const plan = getPaymentPlanDetails(planType, installmentNumber);
    if (!plan) {
      return res.status(400).json({ error: 'Invalid payment plan specified.' });
    }

    const options = {
      amount: plan.amount * 100,
      currency: 'INR',
      receipt: 'rcpt_' + Date.now(),
      notes: { courseName, studentName, studentPhone, planType, installmentNumber: installmentNumber || '', enrollmentId: enrollmentId || '' }
    };

    const order = await razorpay.orders.create(options);

    res.json({
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      keyId: process.env.RAZORPAY_KEY_ID,
      planLabel: plan.label
    });
  } catch (err) {
    console.error('Error creating Razorpay order:', err);
    res.status(500).json({ error: 'Failed to create order. Please try again.' });
  }
});

// ─────────────────────────────────────────────
// ROUTE: VERIFY PAYMENT
// ─────────────────────────────────────────────
app.post('/api/verify-payment', async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, enrollment, planType, installmentNumber } = req.body;

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ error: 'Missing Razorpay payment fields.' });
    }

    const body = razorpay_order_id + '|' + razorpay_payment_id;
    const expectedSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(body.toString())
      .digest('hex');

    if (expectedSignature !== razorpay_signature) {
      return res.status(400).json({ verified: false, error: 'Payment signature verification failed.' });
    }

    const plan = getPaymentPlanDetails(planType, installmentNumber);
    const bookingId = 'MPF-' + new Date().getFullYear() + '-' + Math.floor(100000 + Math.random() * 900000);
    const today = new Date().toISOString().split('T')[0];

    const record = {
      bookingId,
      razorpay_order_id,
      razorpay_payment_id,
      name: enrollment?.name || '',
      phone: enrollment?.phone || '',
      email: enrollment?.email || '',
      course: enrollment?.course || '',
      planType: planType || '',
      installmentNumber: installmentNumber || '',
      planLabel: plan ? plan.label : '',
      amountPaid: plan ? plan.amount : 0,
      date: enrollment?.date || '',
      slot: enrollment?.slot || '',
      mode: enrollment?.mode || '',
      status: 'paid'
    };

    if (planType === 'installments' && parseInt(installmentNumber, 10) === 1) {
      const dueDates = calculateDueDates(today);
      record.installment2DueDate = dueDates.installment2DueDate;
      record.installment3DueDate = dueDates.installment3DueDate;
      record.installment2Paid = false;
      record.installment3Paid = false;
      record.paymentStatus = 'on_track';
    }

    if (planType === 'installments' && parseInt(installmentNumber, 10) > 1) {
      record.paymentStatus = 'completed_this_installment';
    }

    await saveToFirestore('enrollments', bookingId, record);

    logToGoogleSheet('Enrollments', {
      'Booking ID': bookingId,
      'Name': record.name,
      'Phone': record.phone,
      'Email': record.email,
      'Course': record.course,
      'Plan Type': record.planType,
      'Installment #': record.installmentNumber,
      'Plan Label': record.planLabel,
      'Amount Paid': record.amountPaid,
      'Demo Date': record.date,
      'Time Slot': record.slot,
      'Mode': record.mode,
      'Razorpay Order ID': razorpay_order_id,
      'Razorpay Payment ID': razorpay_payment_id,
      'Status': 'paid'
    });

    sendNotificationEmail(
      `🎉 Payment Received: ${record.course} — ${record.name}`,
      `<div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;">
        <h2 style="color:#6d28d9;">New Payment Received</h2>
        <table style="width:100%;border-collapse:collapse;font-size:14px;">
          <tr><td style="padding:8px;font-weight:bold;">Booking ID</td><td style="padding:8px;">${bookingId}</td></tr>
          <tr><td style="padding:8px;font-weight:bold;">Student Name</td><td style="padding:8px;">${record.name}</td></tr>
          <tr><td style="padding:8px;font-weight:bold;">Phone</td><td style="padding:8px;">${record.phone}</td></tr>
          <tr><td style="padding:8px;font-weight:bold;">Email</td><td style="padding:8px;">${record.email || '—'}</td></tr>
          <tr><td style="padding:8px;font-weight:bold;">Course</td><td style="padding:8px;">${record.course}</td></tr>
          <tr><td style="padding:8px;font-weight:bold;">Payment Plan</td><td style="padding:8px;">${record.planLabel}</td></tr>
          <tr><td style="padding:8px;font-weight:bold;">Amount Paid</td><td style="padding:8px;">₹${record.amountPaid}</td></tr>
          <tr><td style="padding:8px;font-weight:bold;">Razorpay Payment ID</td><td style="padding:8px;">${razorpay_payment_id}</td></tr>
        </table>
      </div>`
    );

    res.json({ verified: true, bookingId, amountPaid: record.amountPaid, planLabel: record.planLabel });
  } catch (err) {
    console.error('Error verifying payment:', err);
    res.status(500).json({ error: 'Payment verification failed due to a server error.' });
  }
});

// ─────────────────────────────────────────────
// ROUTE: ENQUIRY FORM
// ─────────────────────────────────────────────
app.post('/api/enquiry', async (req, res) => {
  try {
    const { name, phone, course, message } = req.body;
    if (!name || !phone) {
      return res.status(400).json({ error: 'Name and phone are required.' });
    }

    const enquiryId = 'ENQ-' + Date.now();
    const data = { name, phone, course: course || '', message: message || '' };

    await saveToFirestore('enquiries', enquiryId, data);
    logToGoogleSheet('Enquiries', { 'Name': name, 'Phone': phone, 'Course': course || '', 'Message': message || '' });
    sendNotificationEmail(
      `📩 New Enquiry from ${name}`,
      `<div style="font-family:Arial,sans-serif;"><h3>New Website Enquiry</h3><p><strong>Name:</strong> ${name}</p><p><strong>Phone:</strong> ${phone}</p><p><strong>Course:</strong> ${course || '—'}</p><p><strong>Message:</strong> ${message || '—'}</p></div>`
    );

    res.json({ success: true, enquiryId });
  } catch (err) {
    console.error('Error saving enquiry:', err);
    res.status(500).json({ error: 'Could not submit enquiry. Please try again.' });
  }
});

// ─────────────────────────────────────────────
// ROUTE: CALLBACK REQUEST
// ─────────────────────────────────────────────
app.post('/api/callback', async (req, res) => {
  try {
    const { name, phone, preferredTime } = req.body;
    if (!name || !phone) {
      return res.status(400).json({ error: 'Name and phone are required.' });
    }

    const callbackId = 'CB-' + Date.now();
    const data = { name, phone, preferredTime: preferredTime || 'Anytime', status: 'pending' };

    await saveToFirestore('callbacks', callbackId, data);
    logToGoogleSheet('Callbacks', { 'Name': name, 'Phone': phone, 'Preferred Time': preferredTime || 'Anytime', 'Status': 'pending' });
    sendNotificationEmail(
      `📞 Callback Request from ${name}`,
      `<div style="font-family:Arial,sans-serif;"><h3>New Callback Request</h3><p><strong>Name:</strong> ${name}</p><p><strong>Phone:</strong> ${phone}</p><p><strong>Preferred Time:</strong> ${preferredTime || 'Anytime'}</p></div>`
    );

    res.json({ success: true, callbackId });
  } catch (err) {
    console.error('Error saving callback request:', err);
    res.status(500).json({ error: 'Could not submit callback request. Please try again.' });
  }
});

// ─────────────────────────────────────────────
// ROUTE: CHECK OVERDUE INSTALLMENT STUDENTS (admin-only)
// ─────────────────────────────────────────────
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
      if (data.paymentStatus === 'completed') return;

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
// ROUTE: SIGN-UP (popup form)
// ─────────────────────────────────────────────
app.post('/api/signup', async (req, res) => {
  try {
    const { name, phone, email } = req.body;
    if (!name || !phone) {
      return res.status(400).json({ error: 'Name and phone are required.' });
    }

    const signupId = 'SU-' + Date.now();
    const data = { name, phone, email: email || '', source: 'popup_signup' };

    await saveToFirestore('signups', signupId, data);
    logToGoogleSheet('Signups', { 'Name': name, 'Phone': phone, 'Email': email || '' });
    sendNotificationEmail(
      `🎯 New Sign-Up from ${name}`,
      `<div style="font-family:Arial,sans-serif;"><h3>New Pop-Up Sign-Up</h3><p><strong>Name:</strong> ${name}</p><p><strong>Phone:</strong> ${phone}</p><p><strong>Email:</strong> ${email || '—'}</p></div>`
    );

    res.json({ success: true, signupId });
  } catch (err) {
    console.error('Error saving signup:', err);
    res.status(500).json({ error: 'Could not submit sign-up. Please try again.' });
  }
});

// ─────────────────────────────────────────────
// START SERVER
// ─────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅ MPULSE backend running on port ${PORT}`);
});
