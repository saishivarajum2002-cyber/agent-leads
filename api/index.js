const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json({limit: '50mb'}));
app.use(express.static(path.join(__dirname, '..')));

require('dotenv').config();
const { sendEmail } = require('../services/email');
const { pushNotification, saveLeadToSupabase, saveVisitToSupabase, updateVisitInSupabase, getVisitFromSupabase, getVisitsByDate } = require('../services/supabase');
const { generateDescription } = require('../services/ai');

// Constants
const MONGODB_URI = process.env.MONGODB_URI;

// Connection Cache (Serverless best practice)
let cachedConnection = null;

const connectDB = async () => {
  if (cachedConnection) return cachedConnection;

  if (!MONGODB_URI) {
    const errorMsg = '❌ MONGODB_URI is missing in environment variables!';
    console.error(errorMsg);
    throw new Error(errorMsg);
  }

  try {
    // Basic connection options
    const options = {
      serverSelectionTimeoutMS: 5000, // Timeout after 5s
      socketTimeoutMS: 45000,         // Close sockets after 45s of inactivity
    };

    console.log('⏳ Connecting to MongoDB Atlas...');
    cachedConnection = await mongoose.connect(MONGODB_URI, options);
    console.log('✅ MongoDB Connected to Atlas');
    return cachedConnection;
  } catch (err) {
    cachedConnection = null; // Reset on failure
    console.error('❌ MongoDB Connection Error:', err.message);
    if (err.message.includes('IP not whitelisted')) {
      console.error('👉 ACTION REQUIRED: Add 0.0.0.0/0 to your MongoDB Atlas Network Access.');
    }
    throw err;
  }
};

// Middleware to ensure DB is connected before handling requests
app.use(async (req, res, next) => {
  try {
    await connectDB();
    next();
  } catch (err) {
    const isWhitelistedError = err.message.includes('IP not whitelisted');
    res.status(500).json({ 
      error: 'Database Connection Failed', 
      details: err.message,
      suggestion: isWhitelistedError ? 'Update MongoDB Atlas Network Access to allow all IPs (0.0.0.0/0)' : 'Check environment variables and Atlas status'
    });
  }
});

// ==========================================
// SCHEMAS
// ==========================================
const DataSnapshotSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true },
  data: { type: Object, default: {} }
}, { timestamps: true });

const PeTokenSchema = new mongoose.Schema({
  email: { type: String, required: true },
  platform: { type: String, enum: ['zoom', 'google'], required: true },
  access_token: String,
  refresh_token: String,
  expiry: Date
}, { timestamps: true });
PeTokenSchema.index({ email: 1, platform: 1 }, { unique: true });

// Models (Handle re-compilation in serverless)
const PeToken = mongoose.models.PeToken || mongoose.model('PeToken', PeTokenSchema);
const DataSnapshot = mongoose.models.DataSnapshot || mongoose.model('DataSnapshot', DataSnapshotSchema);

// ==========================================
// OAUTH & INTEGRATIONS
// ==========================================

// 1. WhatsApp Templates & Visit Status Status
const VISIT_STATUSES = ['pending', 'confirmed', 'completed', 'cancelled'];
const VISIT_OUTCOMES = ['interested', 'not interested', 'negotiation'];

// 2. Status Check
app.get('/api/integration-status', async (req, res) => {
  const { email } = req.query;
  const tokens = await PeToken.find({ email });
  const status = { google: tokens.some(t => t.platform === 'google') };
  res.json(status);
});

// 2.5 Availability Check
app.get('/api/availability', async (req, res) => {
  const { date } = req.query;
  if (!date) return res.status(400).json({ error: 'Date is required' });
  
  try {
    const visits = await getVisitsByDate(date);
    if (visits.success) {
      // Return list of busy times
      const busyTimes = visits.data.map(v => v.visit_time.substring(0, 5)); // HH:mm
      return res.json({ success: true, busyTimes });
    }
    throw new Error(visits.error);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch availability: ' + error.message });
  }
});

// 3. Property Visits
app.post('/api/visits', async (req, res) => {
  const { agentEmail, visit } = req.body;
  try {
    if (!agentEmail || !visit) return res.status(400).json({ error: 'agentEmail and visit required' });

    // 0. Double Booking Check
    const availability = await getVisitsByDate(visit.visit_date);
    if (availability.success) {
      const isBooked = availability.data.some(v => v.visit_time.substring(0, 5) === visit.visit_time.substring(0, 5));
      if (isBooked) return res.status(409).json({ error: 'This time slot is already booked.' });
    }

    // 1. Save to Supabase
    const supabaseResult = await saveVisitToSupabase({
      ...visit,
      status: visit.status || 'pending',
      created_at: new Date().toISOString()
    });

    // 2. Save to MongoDB (Sync)
    let mongodbSaved = false;
    try {
      let snapshot = await DataSnapshot.findOne({ email: agentEmail });
      if (!snapshot) snapshot = new DataSnapshot({ email: agentEmail, data: { pe_visits: [] } });
      if (!snapshot.data.pe_visits) snapshot.data.pe_visits = [];
      
      const newVisit = { ...visit, id: visit.id || Date.now().toString(36), created_at: new Date().toISOString() };
      snapshot.data.pe_visits.unshift(newVisit);
      snapshot.markModified('data');
      await snapshot.save();
      mongodbSaved = true;
    } catch (e) { console.error('MongoDB Visit Error:', e.message); }

    // 3. Send Notification Email to Agent (New Booking Alert)
    console.log(`📧 API: Sending Agent Alert to [${agentEmail}]`);
    await sendEmail({
      to: agentEmail,
      subject: `🔔 NEW BOOKING ALERT: ${visit.client_name}`,
      message: `Hi Sarah,\n\nYou have a new property visit request!\n\n🏠 Property: ${visit.property_name}\n👤 Client: ${visit.client_name}\n📅 Date: ${visit.visit_date}\n🕒 Time: ${visit.visit_time}\n📞 Phone: ${visit.client_phone || 'N/A'}\n\nPlease log in to your dashboard to confirm or reject this booking.`
    });

    // 4. Send Initial Email to User (Visit Booked Successfully)
    if (visit.client_email) {
      console.log(`📧 API: Sending Client Confirmation to [${visit.client_email}]`);
      await sendEmail({
        to: visit.client_email,
        subject: `Your visit is booked successfully: ${visit.property_name}`,
        message: `Hi ${visit.client_name},\n\nYour visit request for ${visit.property_name} has been received and is currently Pending agent approval.\n\nBooking Details:\n📅 Date: ${visit.visit_date}\n🕒 Time: ${visit.visit_time}\n\nAgent Contact:\n📧 Email: ${agentEmail}\n📞 Phone: +971 50 123 4567\n\nWe will notify you once your visit is confirmed.`
      });
    } else {
      console.warn('⚠️ API: No client email found for notification.');
    }

    // 5. Save Notification to MongoDB PeNotifications
    try {
      let snapshot = await DataSnapshot.findOne({ email: agentEmail });
      if (snapshot) {
        if (!snapshot.data.pe_notifications) snapshot.data.pe_notifications = [];
        snapshot.data.pe_notifications.unshift({
          id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
          title: 'Tour Request: ' + visit.client_name,
          description: `Wants to visit ${visit.property_name} · ${visit.visit_date} ${visit.visit_time}`,
          type: 'booking',
          bookingId: visit.id,
          icon: '📅',
          is_read: false,
          created_at: new Date().toISOString()
        });
        snapshot.markModified('data');
        await snapshot.save();
      }
    } catch (e) { console.error('Notification Save Error:', e.message); }

    await pushNotification(agentEmail, 'new_visit', `New booking alert: ${visit.client_name} requested a visit.`);

    return res.json({ success: true, supabaseSaved: supabaseResult.success, mongodbSaved });
  } catch (error) {
    res.status(500).json({ error: 'Failed to create visit: ' + error.message });
  }
});

app.patch('/api/visits/:id', async (req, res) => {
  const { id } = req.params;
  const { agentEmail, updates } = req.body;
  
  // Normalize status to lowercase if provided
  if (updates && updates.status) {
    updates.status = updates.status.toLowerCase();
  }

  try {
    // 1. Update Supabase
    const supabaseResult = await updateVisitInSupabase(id, updates);

    // 2. Update MongoDB
    if (agentEmail) {
      const snapshot = await DataSnapshot.findOne({ email: agentEmail });
      if (snapshot && snapshot.data.pe_visits) {
        const idx = snapshot.data.pe_visits.findIndex(v => v.id === id);
        if (idx !== -1) {
          snapshot.data.pe_visits[idx] = { ...snapshot.data.pe_visits[idx], ...updates };
          snapshot.markModified('data');
          await snapshot.save();
        }
      }
    }

    // 3. Send Notifications
    try {
      const visitRes = await getVisitFromSupabase(id);
      if (visitRes.success) {
        const v = visitRes.data;
        const isConfirmed = String(updates.status).toLowerCase() === 'confirmed';
        const isRescheduled = updates.visit_date || updates.visit_time;

        if (isConfirmed) {
          console.log(`✅ Visit Approved! Preparing confirmation for [${v.client_name}]`);
        }

        if (isConfirmed || isRescheduled) {
          const subject = isRescheduled ? `🔄 Visit Rescheduled: ${v.property_name}` : `✅ Your visit is confirmed: ${v.property_name}`;
          const msg = isRescheduled 
            ? `Hi ${v.client_name},\n\nYour property visit for ${v.property_name} has been rescheduled.\n\n📅 New Date: ${updates.visit_date || v.visit_date}\n🕒 New Time: ${updates.visit_time || v.visit_time}\n\nWe look forward to seeing you!`
            : `Hi ${v.client_name},\n\nYour visit is confirmed!\n\nWe look forward to showing you ${v.property_name}.\n\n📅 Date: ${v.visit_date}\n🕒 Time: ${v.visit_time}\n\nAgent: Sarah Al-Rashid\n📞 Phone: +971 50 123 4567`;
          
          if (v.client_email) {
            console.log(`📧 API: Sending Visit Confirmation TO CLIENT [${v.client_email}]`);
            await sendEmail({ to: v.client_email, subject, message: msg });
          } else {
            console.warn('⚠️ API: Client email missing in database for confirmation.');
          }

          console.log(`📧 API: Sending Status Update TO AGENT [${agentEmail}]`);
          await sendEmail({ 
            to: agentEmail, 
            subject: `Update: Visit with ${v.client_name}`, 
            message: `The visit with ${v.client_name} for ${v.property_name} has been updated.\n\nStatus: ${updates.status || v.status}\nDate: ${updates.visit_date || v.visit_date}\nTime: ${updates.visit_time || v.visit_time}`
          });
        }
      }
    } catch (e) { console.error('Notification Error:', e.message); }

    res.json({ success: true, supabaseUpdated: supabaseResult.success });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update visit: ' + error.message });
  }
});

// Generic Email Endpoint (Fix for "/api/send-email" not found)
app.get('/api/send-email', (req, res) => {
  res.json({ message: "API working - Email service is ready" });
});

app.post('/api/send-email', async (req, res) => {
  try {
    const { to, subject, message } = req.body;
    if (!to || !subject || !message) {
      return res.status(400).json({ error: 'to, subject, and message are required' });
    }
    const result = await sendEmail({ to, subject, message });
    if (result.success) {
      res.json({ success: true, message: 'Email sent successfully', data: result.data });
    } else {
      res.status(500).json({ error: result.error });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// AI Tool: Generate Property Description
app.post('/api/ai/description', async (req, res) => {
  try {
    const { details } = req.body;
    if (!details) return res.status(400).json({ error: 'Property details required' });
    const result = await generateDescription(details);
    if (result.success) {
      res.json({ text: result.text });
    } else {
      res.status(500).json({ error: result.error });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Unified Lead Submission & Notification
app.post('/api/leads', async (req, res) => {
  try {
    const { agentEmail, lead } = req.body;
    if (!agentEmail || !lead) return res.status(400).json({ error: 'agentEmail and lead required' });

    console.log(`📩 Processing lead for ${agentEmail}: ${lead.name}`);

    // 1. Save to Supabase (Primary)
    let supabaseResult = { success: false, error: 'Not attempted' };
    try {
      supabaseResult = await saveLeadToSupabase(lead);
    } catch (e) { console.error('Supabase Error:', e.message); }
    
    // 2. Save to MongoDB (Backup / Snapshot)
    let mongodbSaved = false;
    try {
      let snapshot = await DataSnapshot.findOne({ email: agentEmail });
      if (!snapshot) snapshot = new DataSnapshot({ email: agentEmail, data: { pe_leads: [] } });
      if (!snapshot.data) snapshot.data = {};
      if (!snapshot.data.pe_leads) snapshot.data.pe_leads = [];
      
      lead.created_at = lead.created_at || new Date().toISOString();
      lead.id = lead.id || (Date.now().toString(36) + Math.random().toString(36).slice(2, 6));
      
      snapshot.data.pe_leads.unshift(lead);
      snapshot.markModified('data');
      await snapshot.save();
      mongodbSaved = true;
    } catch (e) { console.error('MongoDB Error:', e.message); }

    // 3. Send Notification Email via Resend (Crucial)
    let emailResult = { success: false, error: 'Not attempted' };
    try {
      emailResult = await sendEmail({
        to: agentEmail,
        subject: `🔔 New Lead: ${lead.name}`,
        message: `Hi,\n\nYou have a new lead!\n\n👤 Name: ${lead.name}\n📞 Phone: ${lead.phone || 'N/A'}\n📧 Email: ${lead.email || 'N/A'}\n🏠 Interest: ${lead.property_interest || 'N/A'}\n📝 Notes: ${lead.notes || 'N/A'}\n\nLog in to your dashboard to take action.`
      });
    } catch (e) { 
      console.error('Email Error:', e.message);
      emailResult.error = e.message;
    }

    // 4. Push Notification
    try {
      await pushNotification(agentEmail, 'new_lead', `New lead: ${lead.name}`);
    } catch (e) {}

    // Return success if AT LEAST the email was sent or one storage succeeded
    // This ensures the USER sees the "Thank You" message as requested
    const isSuccess = emailResult.success || supabaseResult.success || mongodbSaved;
    
    res.json({ 
      success: isSuccess, 
      supabaseSaved: supabaseResult.success,
      mongodbSaved: mongodbSaved,
      emailSent: emailResult.success,
      error: isSuccess ? null : 'Failed to process lead. Please check configuration.',
      details: {
        supabase: supabaseResult.error || (supabaseResult.success ? 'OK' : 'Failed'),
        mongodb: mongodbSaved ? 'OK' : 'Failed',
        email: emailResult.error || (emailResult.success ? 'OK' : 'Failed')
      }
    });
  } catch (error) {
    console.error('Lead Submission Critical Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Dedicated Lead Notification Endpoint (Legacy)
app.post('/api/notify-lead', async (req, res) => {
  try {
    const { agentEmail, lead } = req.body;
    if (!agentEmail || !lead) return res.status(400).json({ error: 'agentEmail and lead required' });
    
    console.log(`🔔 Lead notification for ${agentEmail}`);
    
    const emailResult = await sendEmail({
      to: agentEmail,
      subject: `🔔 New Lead: ${lead.name}`,
      message: `Hi,\n\nYou have a new lead!\n\n👤 Name: ${lead.name}\n📞 Phone: ${lead.phone || 'N/A'}\n🏠 Property Interest: ${lead.property_interest || 'N/A'}\n\nLog in to your dashboard to take action.`
    });
    
    // Save Notification to MongoDB
    try {
      let snapshot = await DataSnapshot.findOne({ email: agentEmail });
      if (snapshot) {
        if (!snapshot.data.pe_notifications) snapshot.data.pe_notifications = [];
        snapshot.data.pe_notifications.unshift({
          id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
          title: 'New Lead: ' + lead.name,
          description: `Interested in ${lead.property_interest || 'Listing'}`,
          type: 'lead',
          icon: '👤',
          is_read: false,
          created_at: new Date().toISOString()
        });
        snapshot.markModified('data');
        await snapshot.save();
      }
    } catch (e) { console.error('Notification Save Error:', e.message); }

    await pushNotification(agentEmail, 'new_lead', `New lead: ${lead.name}`);
    
    res.json({ success: true, emailSent: emailResult.success });
  } catch (error) {
    console.error('Notify Lead Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Sync Endpoints
app.get('/api/sync', async (req, res) => {
  try {
    const { email } = req.query;
    if (!email) return res.status(400).json({ error: 'Email required' });
    const snapshot = await DataSnapshot.findOne({ email });
    res.json(snapshot && snapshot.data ? snapshot.data : {});
  } catch (error) {
    console.error('Sync GET Error:', error.message);
    res.status(500).json({ error: 'Database Error: ' + error.message });
  }
});

app.post('/api/sync', async (req, res) => {
  try {
    const { email, data } = req.body;
    if (!email || !data) return res.status(400).json({ error: 'Email and data required' });
    
    // Check for new leads to notify agent (Safe parsing)
    const oldSnapshot = await DataSnapshot.findOne({ email });
    
    const getLeads = (snapshotData) => {
      const val = snapshotData && snapshotData.pe_leads;
      if (!val) return [];
      if (typeof val === 'string') {
        try { return JSON.parse(val); } catch(e) { return []; }
      }
      return val;
    };

    const oldLeads = getLeads(oldSnapshot ? oldSnapshot.data : null);
    const newLeads = getLeads(data);
    
    await DataSnapshot.findOneAndUpdate({ email }, { email, data }, { upsert: true });
    res.json({ success: true });
  } catch (error) {
    console.error('Sync POST Error:', error.message);
    res.status(500).json({ error: 'Database Error: ' + error.message });
  }
});

// Start Server locally
if (process.env.NODE_ENV !== 'production' && !process.env.VERCEL) {
  const PORT = process.env.PORT || 5000;
  app.listen(PORT, () => console.log(`🚀 Local Server running on port ${PORT}`));
}

// Export for Vercel
module.exports = app;
