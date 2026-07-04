const mongoose = require('mongoose');

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/mpulse';

let isConnected = false;

async function connectDB() {
  if (isConnected) return;
  try {
    if (!process.env.MONGODB_URI) {
      console.warn("⚠️ MONGODB_URI not set. Attempting local MongoDB connection to mongodb://127.0.0.1:27017/mpulse");
    }
    await mongoose.connect(MONGODB_URI, {
      serverSelectionTimeoutMS: 5000 // Timeout after 5s instead of hanging
    });
    isConnected = true;
    console.log("✅ MongoDB connected successfully!");
  } catch (err) {
    console.error("❌ MongoDB connection failed:", err.message);
    console.warn("⚠️ Server will run with database operations disabled or mocked!");
  }
}

// ── SCHEMAS & MODELS ──────────────────────────────────────────

// 1. Enrollment Model
const enrollmentSchema = new mongoose.Schema({
  bookingId: { type: String, required: true, unique: true },
  razorpay_order_id: String,
  razorpay_payment_id: String,
  name: { type: String, required: true },
  phone: { type: String, required: true },
  email: String,
  status: String,
  course: { type: String, required: true },
  message: String,
  planType: String,
  installmentNumber: String,
  planLabel: String,
  amountPaid: { type: Number, default: 0 },
  date: String,
  slot: String,
  mode: String,
  type: { type: String, default: 'enrollment' },
  paymentStatus: String,
  installment2DueDate: String,
  installment2Paid: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now }
});

const Enrollment = mongoose.models.Enrollment || mongoose.model('Enrollment', enrollmentSchema);

// 2. Callback Model
const callbackSchema = new mongoose.Schema({
  name: { type: String, required: true },
  phone: { type: String, required: true },
  preferredTime: { type: String, default: 'Anytime' },
  status: { type: String, default: 'pending' }, // pending / completed
  type: { type: String, default: 'callback' },
  createdAt: { type: Date, default: Date.now }
});

const Callback = mongoose.models.Callback || mongoose.model('Callback', callbackSchema);

// 3. Enquiry Model
const enquirySchema = new mongoose.Schema({
  name: { type: String, required: true },
  phone: { type: String, required: true },
  course: String,
  message: String,
  type: { type: String, default: 'enquiry' },
  createdAt: { type: Date, default: Date.now }
});

const Enquiry = mongoose.models.Enquiry || mongoose.model('Enquiry', enquirySchema);

// 4. Signup Model
const signupSchema = new mongoose.Schema({
  name: { type: String, required: true },
  phone: { type: String, required: true },
  email: String,
  type: { type: String, default: 'signup' },
  createdAt: { type: Date, default: Date.now }
});

const Signup = mongoose.models.Signup || mongoose.model('Signup', signupSchema);

// 5. DemoBooking Model
const demoBookingSchema = new mongoose.Schema({
  bookingId: { type: String, required: true, unique: true },
  name: { type: String, required: true },
  phone: { type: String, required: true },
  email: String,
  status: String,
  course: String,
  date: String,
  slot: String,
  mode: String,
  message: String,
  type: { type: String, default: 'demo_booking' },
  paymentStatus: { type: String, default: 'free_demo' },
  createdAt: { type: Date, default: Date.now }
});

const DemoBooking = mongoose.models.DemoBooking || mongoose.model('DemoBooking', demoBookingSchema);

// 6. Student Model
const studentSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  phone: { type: String, required: true },
  password: { type: String, required: true },
  isPaid: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now }
});
const Student = mongoose.models.Student || mongoose.model('Student', studentSchema);

// 7. LiveClass Model
const liveClassSchema = new mongoose.Schema({
  title: { type: String, required: true },
  date: { type: String, required: true },
  time: { type: String, required: true },
  channelName: { type: String, required: true },
  status: { type: String, default: 'upcoming' }, // upcoming, live, ended
  createdAt: { type: Date, default: Date.now }
});
const LiveClass = mongoose.models.LiveClass || mongoose.model('LiveClass', liveClassSchema);

// 8. Recording Model
const recordingSchema = new mongoose.Schema({
  title: { type: String, required: true },
  videoUrl: { type: String, required: true },
  createdAt: { type: Date, default: Date.now }
});
const Recording = mongoose.models.Recording || mongoose.model('Recording', recordingSchema);

// 9. Resource Model
const resourceSchema = new mongoose.Schema({
  title: { type: String, required: true },
  fileUrl: { type: String, required: true },
  type: { type: String, default: 'pdf' }, // pdf, assignment
  createdAt: { type: Date, default: Date.now }
});
const Resource = mongoose.models.Resource || mongoose.model('Resource', resourceSchema);

// 10. ClassroomName Model
const classroomNameSchema = new mongoose.Schema({
  channelName: { type: String, required: true },
  uid: { type: Number, required: true },
  name: { type: String, required: true },
  role: { type: String, default: 'student' },
  handRaised: { type: Boolean, default: false },
  micAllowed: { type: Boolean, default: false },
  videoAllowed: { type: Boolean, default: false },
  updatedAt: { type: Date, default: Date.now }
});
classroomNameSchema.index({ channelName: 1, uid: 1 }, { unique: true });
const ClassroomName = mongoose.models.ClassroomName || mongoose.model('ClassroomName', classroomNameSchema);

// Exporting connection function and models
module.exports = {
  connectDB,
  models: {
    Enrollment,
    Callback,
    Enquiry,
    Signup,
    DemoBooking,
    Student,
    LiveClass,
    Recording,
    Resource,
    ClassroomName
  },
  getIsConnected: () => isConnected
};

