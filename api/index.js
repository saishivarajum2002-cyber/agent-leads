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
const { pushNotification, saveLeadToSupabase, saveVisitToSupabase, updateVisitInSupabase, deleteVisitFromSupabase, getVisitFromSupabase, getVisitsByDate } = require('../services/supabase');
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
    const { success: supabaseSaved, data: savedVisit, error: supabaseError } = await saveVisitToSupabase({
      ...visit,
      status: visit.status || 'pending',
      created_at: new Date().toISOString()
    });

    if (!supabaseSaved) {
      console.error('❌ Supabase Save Failure:', supabaseError);
      return res.status(500).json({ error: 'Database Save Failed: ' + supabaseError });
    }

    // Capture the REAL ID from Supabase
    const realId = savedVisit.id;
    console.log(`📌 Generated Supabase ID: ${realId}`);

    // 2. Save to MongoDB (Sync)
    let mongodbSaved = false;
    try {
      let snapshot = await DataSnapshot.findOne({ email: agentEmail });
      if (!snapshot) snapshot = new DataSnapshot({ email: agentEmail, data: { pe_visits: [] } });
      if (!snapshot.data.pe_visits) snapshot.data.pe_visits = [];
      
      const newVisit = { ...visit, id: realId, created_at: new Date().toISOString() };
      snapshot.data.pe_visits.unshift(newVisit);
      snapshot.markModified('data');
      await snapshot.save();
      mongodbSaved = true;
    } catch (e) { console.error('MongoDB Visit Error:', e.message); }

    // 3. Send Notification Email to Agent (New Booking Alert) with HTML
    console.log(`📧 API: Sending Agent Alert to [${agentEmail}]`);
    const agentAlertResult = await sendEmail({
      to: agentEmail,
      subject: `🔔 New Visit Request: ${visit.client_name} → ${visit.property_name}`,
      message: `New property visit request received!\n\n📌 Property: ${visit.property_name}\n👤 Client: ${visit.client_name}\n📧 Email: ${visit.client_email || 'N/A'}\n📞 Phone: ${visit.client_phone || 'N/A'}\n📅 Date: ${visit.visit_date}\n🕒 Time: ${visit.visit_time}\n\nPlease log in to your dashboard to confirm or reject this booking.\n\nDashboard: https://agent-leads.vercel.app/propedge_dashboard.html`,
      html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#f9f9f9;border-radius:8px;overflow:hidden"><div style="background:#1a1a18;padding:24px;text-align:center"><h2 style="color:#d4b483;margin:0;font-size:22px">🔔 New Visit Request</h2></div><div style="background:#fff;padding:24px"><p style="color:#333;margin-top:0">Hi Sai Shiva,</p><p style="color:#555">A new property visit has been requested. Please review and confirm or reject it from your dashboard.</p><table style="width:100%;border-collapse:collapse;margin:16px 0"><tr style="background:#f5f5f5"><td style="padding:10px;border:1px solid #ddd;font-weight:bold;color:#333;width:35%">🏠 Property</td><td style="padding:10px;border:1px solid #ddd;color:#555">${visit.property_name}</td></tr><tr><td style="padding:10px;border:1px solid #ddd;font-weight:bold;color:#333">👤 Client</td><td style="padding:10px;border:1px solid #ddd;color:#555">${visit.client_name}</td></tr><tr style="background:#f5f5f5"><td style="padding:10px;border:1px solid #ddd;font-weight:bold;color:#333">📧 Email</td><td style="padding:10px;border:1px solid #ddd;color:#555">${visit.client_email || 'N/A'}</td></tr><tr><td style="padding:10px;border:1px solid #ddd;font-weight:bold;color:#333">📞 Phone</td><td style="padding:10px;border:1px solid #ddd;color:#555">${visit.client_phone || 'N/A'}</td></tr><tr style="background:#f5f5f5"><td style="padding:10px;border:1px solid #ddd;font-weight:bold;color:#333">📅 Date</td><td style="padding:10px;border:1px solid #ddd;color:#555">${visit.visit_date}</td></tr><tr><td style="padding:10px;border:1px solid #ddd;font-weight:bold;color:#333">🕒 Time</td><td style="padding:10px;border:1px solid #ddd;color:#555">${visit.visit_time}</td></tr></table><div style="text-align:center;margin-top:20px"><a href="https://agent-leads.vercel.app/propedge_dashboard.html" style="background:#b8965a;color:#fff;padding:12px 28px;text-decoration:none;border-radius:6px;font-weight:bold;display:inline-block">Open Dashboard →</a></div></div><div style="background:#1a1a18;padding:14px;text-align:center"><p style="color:#888;font-size:12px;margin:0">PropEdge • saishivaraju.m2002@gmail.com</p></div></div>`
    });
    console.log(`📧 API: Agent Alert Result: ${agentAlertResult.success ? 'SUCCESS' : 'FAILED: '+JSON.stringify(agentAlertResult.error)}`);

    // 4. Send Initial Confirmation Email to Client
    if (visit.client_email) {
      console.log(`📧 API: Sending Client Booking Confirmation to [${visit.client_email}]`);
      const clientResult = await sendEmail({
        to: visit.client_email,
        subject: `✅ Visit Request Received: ${visit.property_name}`,
        message: `Hi ${visit.client_name},\n\nYour visit request has been received and is pending agent approval.\n\n📌 Property: ${visit.property_name}\n📅 Date: ${visit.visit_date}\n🕒 Time: ${visit.visit_time}\n\nWe will email you once your visit is confirmed.\n\nAgent: saishivaraju.m2002@gmail.com`,
        html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#f9f9f9;border-radius:8px;overflow:hidden"><div style="background:#1a1a18;padding:24px;text-align:center"><h2 style="color:#d4b483;margin:0">Visit Request Received</h2></div><div style="background:#fff;padding:24px"><p style="color:#333;margin-top:0">Hi ${visit.client_name},</p><p style="color:#555">Thank you! Your property visit request has been received. The agent will confirm your booking shortly.</p><div style="background:#fffbf0;border:1px solid #d4b483;border-radius:6px;padding:16px;margin:16px 0"><p style="margin:0 0 8px;font-weight:bold;color:#333">📋 Your Booking Details</p><p style="margin:4px 0;color:#555"><strong>Property:</strong> ${visit.property_name}</p><p style="margin:4px 0;color:#555"><strong>Date:</strong> ${visit.visit_date}</p><p style="margin:4px 0;color:#555"><strong>Time:</strong> ${visit.visit_time}</p><p style="margin:4px 0;color:#f0a030"><strong>Status:</strong> ⏳ Pending Confirmation</p></div><p style="color:#777;font-size:13px">We will send you another email once the agent confirms your visit.</p></div><div style="background:#1a1a18;padding:14px;text-align:center"><p style="color:#888;font-size:12px;margin:0">PropEdge Real Estate • saishivaraju.m2002@gmail.com</p></div></div>`
      });
      console.log(`📧 API: Client Confirmation Result: ${clientResult.success ? 'SUCCESS' : 'FAILED: '+JSON.stringify(clientResult.error)}`);
    } else {
      console.warn('⚠️ API: No client email found for booking confirmation.');
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
          bookingId: realId,
          icon: '📅',
          is_read: false,
          created_at: new Date().toISOString()
        });
        snapshot.markModified('data');
        await snapshot.save();
      }
    } catch (e) { console.error('Notification Save Error:', e.message); }

    await pushNotification(agentEmail, 'new_visit', `New booking alert: ${visit.client_name} requested a visit.`);

    return res.json({ success: true, supabaseSaved: true, mongodbSaved, id: realId });
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

    // 3. Send Notification Emails
    try {
      const visitRes = await getVisitFromSupabase(id);
      if (visitRes.success) {
        const v = visitRes.data;
        const targetAgentEmail = agentEmail || 'saishivaraju.m2002@gmail.com';
        const isConfirmed = String(updates.status || '').toLowerCase() === 'confirmed';
        const isRejected = String(updates.status || '').toLowerCase() === 'rejected';

        // Always email client when status changes to confirmed OR rejected
        if ((isConfirmed || isRejected) && v.client_email) {
          const confirmSubject = isConfirmed
            ? `✅ Your visit is CONFIRMED: ${v.property_name}`
            : `❌ Visit Not Available: ${v.property_name}`;
          const confirmMsg = isConfirmed
            ? `Hi ${v.client_name},\n\nGreat news! Your property visit has been CONFIRMED.\n\n📌 Property: ${v.property_name}\n📅 Date: ${v.visit_date}\n🕒 Time: ${v.visit_time}\n\nAgent Contact:\n👤 Sai Shiva\n📧 saishivaraju.m2002@gmail.com\n📞 +971 50 123 4567\n\nWe look forward to seeing you!`
            : `Hi ${v.client_name},\n\nUnfortunately, the requested visit slot for ${v.property_name} is not available.\n\nPlease visit our website to request a different date/time.\n\nSorry for the inconvenience.`;
          const confirmHtml = isConfirmed
            ? `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#f9f9f9;border-radius:8px;overflow:hidden"><div style="background:#1a1a18;padding:24px;text-align:center"><h2 style="color:#2ecc8a;margin:0">✅ Visit Confirmed!</h2></div><div style="background:#fff;padding:24px"><p style="color:#333;margin-top:0">Hi ${v.client_name},</p><p style="color:#555">Your property visit has been <strong style="color:#2ecc8a">confirmed</strong>. We look forward to seeing you!</p><div style="background:#f0fdf8;border:1px solid #2ecc8a;border-radius:6px;padding:16px;margin:16px 0"><p style="margin:0 0 8px;font-weight:bold;color:#333">📋 Booking Confirmation</p><p style="margin:4px 0;color:#555"><strong>Property:</strong> ${v.property_name}</p><p style="margin:4px 0;color:#555"><strong>Date:</strong> ${v.visit_date}</p><p style="margin:4px 0;color:#555"><strong>Time:</strong> ${v.visit_time}</p><p style="margin:4px 0;color:#2ecc8a"><strong>Status:</strong> ✅ Confirmed</p></div><p style="color:#333;font-weight:bold">Your Agent:</p><p style="color:#555;margin:4px 0">👤 Sai Shiva</p><p style="color:#555;margin:4px 0">📧 saishivaraju.m2002@gmail.com</p><p style="color:#555;margin:4px 0">📞 +971 50 123 4567</p></div><div style="background:#1a1a18;padding:14px;text-align:center"><p style="color:#888;font-size:12px;margin:0">PropEdge Real Estate</p></div></div>`
            : `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto"><div style="background:#1a1a18;padding:24px;text-align:center"><h2 style="color:#e05060;margin:0">Visit Not Available</h2></div><div style="background:#fff;padding:24px"><p>Hi ${v.client_name},</p><p>Unfortunately the visit slot for <strong>${v.property_name}</strong> (${v.visit_date} at ${v.visit_time}) is not available.</p><p>Please visit our website to request a new date and time.</p></div></div>`;

          console.log(`📧 API: Sending ${isConfirmed ? 'CONFIRMED' : 'REJECTED'} email to client [${v.client_email}]`);
          const clientRes = await sendEmail({ to: v.client_email, subject: confirmSubject, message: confirmMsg, html: confirmHtml });
          console.log(`📧 API: Client Email Result: ${clientRes.success ? 'SUCCESS ✅' : 'FAILED ❌: ' + JSON.stringify(clientRes.error)}`);
        }

        // Save notification in MongoDB for dashboard
        if (agentEmail && (isConfirmed || isRejected)) {
          try {
            let snapshot = await DataSnapshot.findOne({ email: agentEmail });
            if (snapshot) {
              if (!snapshot.data.pe_notifications) snapshot.data.pe_notifications = [];
              snapshot.data.pe_notifications.unshift({
                id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
                title: `Visit ${isConfirmed ? 'Confirmed' : 'Rejected'}: ${v.client_name}`,
                description: `${v.property_name} · ${v.visit_date} ${v.visit_time}`,
                type: 'booking',
                icon: isConfirmed ? '✅' : '❌',
                is_read: false,
                created_at: new Date().toISOString()
              });
              snapshot.markModified('data');
              await snapshot.save();
            }
          } catch(e) { console.error('Patch Notification Save Error:', e.message); }
        }
      }
    } catch (e) {
      console.error('Notification Error in PATCH:', e.message);
    }

    res.json({ success: true, supabaseUpdated: supabaseResult.success });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update visit: ' + error.message });
  }
});

app.delete('/api/visits/:id', async (req, res) => {
  const { id } = req.params;
  const { agentEmail } = req.query; // May be passed via query for MongoDB sync

  try {
    // 1. Delete from Supabase
    const supabaseResult = await deleteVisitFromSupabase(id);

    // 2. Delete from MongoDB
    if (agentEmail) {
      await connectDB();
      const snapshot = await DataSnapshot.findOne({ email: agentEmail });
      if (snapshot && snapshot.data.pe_visits) {
        snapshot.data.pe_visits = snapshot.data.pe_visits.filter(v => v.id !== id);
        snapshot.markModified('data');
        await snapshot.save();
      }
    }

    res.json({ success: true, supabaseDeleted: supabaseResult.success });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete visit: ' + error.message });
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
    // Return success if AT LEAST the email was sent or one storage succeeded
    const isSuccess = emailResult.success || supabaseResult.success || mongodbSaved;
    if (!isSuccess) {
      return res.status(500).json({ success: false, error: 'Failed to process lead: all systems failed.' });
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
