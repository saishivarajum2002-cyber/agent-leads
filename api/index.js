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
const { createGoogleMeeting, getGoogleAuthUrl, getGoogleTokens } = require('../services/google');
const { pushNotification } = require('../services/supabase');
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

// 1. Google OAuth
app.get('/auth/google', (req, res) => {
  const { email } = req.query;
  const url = getGoogleAuthUrl(email);
  res.redirect(url);
});

app.get('/auth/google/callback', async (req, res) => {
  const { code, state: email } = req.query;
  try {
    const tokens = await getGoogleTokens(code);
    await PeToken.findOneAndUpdate(
      { email, platform: 'google' },
      { 
        access_token: tokens.access_token, 
        refresh_token: tokens.refresh_token, 
        expiry: tokens.expiry_date ? new Date(tokens.expiry_date) : null 
      },
      { upsert: true }
    );
    res.send('<script>window.opener.postMessage("google_connected", "*"); window.close();</script>');
  } catch (error) {
    res.status(500).send('Google Auth Error: ' + error.message);
  }
});

// 2. Status Check
app.get('/api/integration-status', async (req, res) => {
  const { email } = req.query;
  const tokens = await PeToken.find({ email });
  const status = { google: tokens.some(t => t.platform === 'google') };
  res.json(status);
});

// 3. Create Meeting
app.post('/api/create-meeting', async (req, res) => {
  const { email, booking } = req.body;
  try {
    const tokenRecord = await PeToken.findOne({ email, platform: 'google' });
    if (!tokenRecord || !tokenRecord.access_token || tokenRecord.access_token.startsWith('MOCK_')) {
      return res.status(400).json({ 
        error: 'google_not_connected',
        message: 'Please connect your Google account in Settings to create a real meeting link.'
      });
    }
    const meetingData = await createGoogleMeeting(booking, tokenRecord);
    if (booking.email) {
      await sendEmail({
        to: booking.email,
        subject: `Meeting Confirmed: Tour of ${booking.property_name}`,
        message: `Hi ${booking.client_name},\n\nYour property tour has been confirmed!\n\nDate: ${booking.visit_date}\nTime: ${booking.visit_time}\n\n📹 Join Meeting: ${meetingData.meeting_link}`
      });
    }
    await sendEmail({
      to: email,
      subject: `Meeting Created: Tour with ${booking.client_name}`,
      message: `Meeting for ${booking.client_name} confirmed at ${meetingData.meeting_link}`
    });
    await pushNotification(email, 'meeting_created', `Meeting scheduled with ${booking.client_name}`);
    return res.json({ meeting_link: meetingData.meeting_link, type: 'google' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to create meeting: ' + error.message });
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

// Dedicated Lead Notification Endpoint
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
    
    if (newLeads.length > oldLeads.length) {
      const lead = newLeads[0];
      if (lead && lead.name) {
        console.log(`📨 New lead detected for ${email}: ${lead.name}`);
        const emailResult = await sendEmail({
          to: email,
          subject: `🔔 New Lead: ${lead.name}`,
          message: `Hi,\n\nYou have a new lead!\n\nName: ${lead.name}\nPhone: ${lead.phone || 'N/A'}\nProperty: ${lead.property_interest || 'N/A'}\n\nCheck your dashboard for more details.`
        });
        await pushNotification(email, 'new_lead', `New lead: ${lead.name}`);
      }
    }

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
