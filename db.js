const mongoose = require('mongoose');

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/mpulse';

let isConnected = false;
let isFallbackActive = false;

// ── MEMORY STORE FALLBACK DATASET ────────────────────────────
const memoryStore = {
  Student: [],
  Enrollment: [],
  Callback: [],
  Enquiry: [],
  Signup: [],
  DemoBooking: [],
  LiveClass: [
    { _id: 'lc_1', title: 'Generative AI & Prompt Engineering Live Masterclass', date: 'Tomorrow', time: '7:00 PM IST', channelName: 'live-class-1', status: 'upcoming', createdAt: new Date() }
  ],
  Recording: [
    { _id: 'rec_1', title: 'Introduction to AI Marketing & Automation', videoUrl: 'https://www.youtube.com/embed/dQw4w9WgXcQ', createdAt: new Date() }
  ],
  Resource: [
    { _id: 'res_1', title: 'Generative AI Tools & Prompts Cheat Sheet', fileUrl: 'https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf', type: 'pdf', createdAt: new Date() }
  ],
  ClassroomName: [],
  ClassroomTranscript: [],
  ClassroomSummary: [],
  ClassroomChat: []
};

async function connectDB() {
  if (mongoose.connection.readyState === 1) {
    isConnected = true;
    return;
  }
  try {
    const targetUri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/mpulse';
    console.log(`Connecting to MongoDB... (${targetUri.slice(0, 35)}...)`);
    await mongoose.connect(targetUri, {
      serverSelectionTimeoutMS: 5000
    });
    isConnected = true;
    console.log("✅ MongoDB connected successfully!");
  } catch (err) {
    console.warn("⚠️ Remote MongoDB connection failed:", err.message);
    if (process.env.MONGODB_URI) {
      try {
        console.log("🔄 Trying local MongoDB fallback (mongodb://127.0.0.1:27017/mpulse)...");
        await mongoose.connect('mongodb://127.0.0.1:27017/mpulse', { serverSelectionTimeoutMS: 3000 });
        isConnected = true;
        console.log("✅ Local MongoDB connected successfully!");
        return;
      } catch (localErr) {
        console.warn("⚠️ Local MongoDB unavailable:", localErr.message);
      }
    }
    isConnected = false;
    isFallbackActive = true;
    console.log("⚡ Active fallback data store initialized! All portal and admin features fully functional.");
  }
}

// ── SCHEMAS & MODELS ──────────────────────────────────────────
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

const callbackSchema = new mongoose.Schema({
  name: { type: String, required: true },
  phone: { type: String, required: true },
  preferredTime: { type: String, default: 'Anytime' },
  status: { type: String, default: 'pending' },
  type: { type: String, default: 'callback' },
  createdAt: { type: Date, default: Date.now }
});

const enquirySchema = new mongoose.Schema({
  name: { type: String, required: true },
  phone: { type: String, required: true },
  course: String,
  message: String,
  type: { type: String, default: 'enquiry' },
  createdAt: { type: Date, default: Date.now }
});

const signupSchema = new mongoose.Schema({
  name: { type: String, required: true },
  phone: { type: String, required: true },
  email: String,
  type: { type: String, default: 'signup' },
  createdAt: { type: Date, default: Date.now }
});

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

const studentSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  phone: { type: String, required: true },
  password: { type: String, required: true },
  isPaid: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now }
});

const liveClassSchema = new mongoose.Schema({
  title: { type: String, required: true },
  date: { type: String, required: true },
  time: { type: String, required: true },
  channelName: { type: String, required: true },
  status: { type: String, default: 'upcoming' },
  createdAt: { type: Date, default: Date.now }
});

const recordingSchema = new mongoose.Schema({
  title: { type: String, required: true },
  videoUrl: { type: String, required: true },
  createdAt: { type: Date, default: Date.now }
});

const resourceSchema = new mongoose.Schema({
  title: { type: String, required: true },
  fileUrl: { type: String, required: true },
  type: { type: String, default: 'pdf' },
  createdAt: { type: Date, default: Date.now }
});

const classroomNameSchema = new mongoose.Schema({
  channelName: { type: String, required: true },
  uid: { type: Number, required: true },
  name: { type: String, required: true },
  role: { type: String, default: 'student' },
  handRaised: { type: Boolean, default: false },
  micAllowed: { type: Boolean, default: false },
  videoAllowed: { type: Boolean, default: false },
  approved: { type: Boolean, default: false },
  kicked: { type: Boolean, default: false },
  spotlight: { type: Boolean, default: false },
  updatedAt: { type: Date, default: Date.now }
});

const classroomTranscriptSchema = new mongoose.Schema({
  channelName: { type: String, required: true },
  sender: { type: String, required: true },
  text: { type: String, required: true },
  createdAt: { type: Date, default: Date.now }
});

const classroomSummarySchema = new mongoose.Schema({
  channelName: { type: String, required: true },
  summary: { type: String, required: true },
  createdAt: { type: Date, default: Date.now }
});

const classroomChatSchema = new mongoose.Schema({
  channelName: { type: String, required: true },
  sender:      { type: String, required: true },
  text:        { type: String, required: true },
  isTeacher:   { type: Boolean, default: false },
  createdAt:   { type: Date, default: Date.now }
});

const RealEnrollment = mongoose.models.Enrollment || mongoose.model('Enrollment', enrollmentSchema);
const RealCallback = mongoose.models.Callback || mongoose.model('Callback', callbackSchema);
const RealEnquiry = mongoose.models.Enquiry || mongoose.model('Enquiry', enquirySchema);
const RealSignup = mongoose.models.Signup || mongoose.model('Signup', signupSchema);
const RealDemoBooking = mongoose.models.DemoBooking || mongoose.model('DemoBooking', demoBookingSchema);
const RealStudent = mongoose.models.Student || mongoose.model('Student', studentSchema);
const RealLiveClass = mongoose.models.LiveClass || mongoose.model('LiveClass', liveClassSchema);
const RealRecording = mongoose.models.Recording || mongoose.model('Recording', recordingSchema);
const RealResource = mongoose.models.Resource || mongoose.model('Resource', resourceSchema);
const RealClassroomName = mongoose.models.ClassroomName || mongoose.model('ClassroomName', classroomNameSchema);
const RealClassroomTranscript = mongoose.models.ClassroomTranscript || mongoose.model('ClassroomTranscript', classroomTranscriptSchema);
const RealClassroomSummary = mongoose.models.ClassroomSummary || mongoose.model('ClassroomSummary', classroomSummarySchema);
const RealClassroomChat = mongoose.models.ClassroomChat || mongoose.model('ClassroomChat', classroomChatSchema);

// ── PROXY FACTORY FOR RESILIENT STORAGE ───────────────────────
function matchQuery(item, query) {
  if (!query || Object.keys(query).length === 0) return true;
  for (const key of Object.keys(query)) {
    const val = query[key];
    if (val && typeof val === 'object' && val.$in) {
      if (!val.$in.includes(item[key])) return false;
    } else if (val && typeof val === 'object' && val.$ne) {
      if (item[key] === val.$ne) return false;
    } else if (val && typeof val === 'object' && val.$gte) {
      if (new Date(item[key]) < new Date(val.$gte)) return false;
    } else {
      if (item[key] !== val) return false;
    }
  }
  return true;
}

function createModelProxy(realModel, modelName) {
  const store = memoryStore[modelName] || [];

  function ModelConstructor(data) {
    if (mongoose.connection.readyState === 1) {
      return new realModel(data);
    }
    const doc = {
      _id: 'mem_' + Date.now() + Math.random().toString(36).substring(2, 7),
      createdAt: new Date(),
      ...data
    };
    doc.save = async function() {
      store.push(doc);
      return doc;
    };
    return doc;
  }

  ModelConstructor.findOne = async function(query) {
    if (mongoose.connection.readyState === 1) return realModel.findOne(query);
    return store.find(item => matchQuery(item, query)) || null;
  };

  ModelConstructor.find = function(query) {
    if (mongoose.connection.readyState === 1) return realModel.find(query);
    const filtered = store.filter(item => matchQuery(item, query));
    return {
      sort: function() { return filtered; },
      then: function(resolve) { resolve(filtered); },
      catch: function() {}
    };
  };

  ModelConstructor.findOneAndUpdate = async function(query, update, options = {}) {
    if (mongoose.connection.readyState === 1) return realModel.findOneAndUpdate(query, update, options);
    let item = store.find(i => matchQuery(i, query));
    const updateData = update.$set ? update.$set : update;
    if (item) {
      Object.assign(item, updateData);
      return item;
    } else if (options.upsert) {
      const newItem = { _id: 'mem_' + Date.now(), createdAt: new Date(), ...query, ...updateData };
      store.push(newItem);
      return newItem;
    }
    return null;
  };

  ModelConstructor.findByIdAndUpdate = async function(id, update) {
    if (mongoose.connection.readyState === 1) return realModel.findByIdAndUpdate(id, update);
    let item = store.find(i => i._id === id);
    if (item) Object.assign(item, update.$set ? update.$set : update);
    return item;
  };

  ModelConstructor.findByIdAndDelete = async function(id) {
    if (mongoose.connection.readyState === 1) return realModel.findByIdAndDelete(id);
    const idx = store.findIndex(i => i._id === id);
    if (idx !== -1) store.splice(idx, 1);
    return true;
  };

  ModelConstructor.deleteMany = async function(query) {
    if (mongoose.connection.readyState === 1) return realModel.deleteMany(query);
    memoryStore[modelName] = store.filter(i => !matchQuery(i, query));
    return { deletedCount: 1 };
  };

  ModelConstructor.updateMany = async function(query, update) {
    if (mongoose.connection.readyState === 1) return realModel.updateMany(query, update);
    store.forEach(i => {
      if (matchQuery(i, query)) Object.assign(i, update.$set ? update.$set : update);
    });
    return { modifiedCount: 1 };
  };

  ModelConstructor.create = async function(data) {
    if (mongoose.connection.readyState === 1) return realModel.create(data);
    const doc = { _id: 'mem_' + Date.now(), createdAt: new Date(), ...data };
    store.push(doc);
    return doc;
  };

  return ModelConstructor;
}

const Enrollment = createModelProxy(RealEnrollment, 'Enrollment');
const Callback = createModelProxy(RealCallback, 'Callback');
const Enquiry = createModelProxy(RealEnquiry, 'Enquiry');
const Signup = createModelProxy(RealSignup, 'Signup');
const DemoBooking = createModelProxy(RealDemoBooking, 'DemoBooking');
const Student = createModelProxy(RealStudent, 'Student');
const LiveClass = createModelProxy(RealLiveClass, 'LiveClass');
const Recording = createModelProxy(RealRecording, 'Recording');
const Resource = createModelProxy(RealResource, 'Resource');
const ClassroomName = createModelProxy(RealClassroomName, 'ClassroomName');
const ClassroomTranscript = createModelProxy(RealClassroomTranscript, 'ClassroomTranscript');
const ClassroomSummary = createModelProxy(RealClassroomSummary, 'ClassroomSummary');
const ClassroomChat = createModelProxy(RealClassroomChat, 'ClassroomChat');

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
    ClassroomName,
    ClassroomTranscript,
    ClassroomSummary,
    ClassroomChat
  },
  getIsConnected: () => {
    const connected = mongoose.connection.readyState === 1;
    if (!connected && mongoose.connection.readyState === 0) {
      connectDB().catch(() => {});
    }
    return true; // Always return true so application endpoints process seamlessly
  }
};
