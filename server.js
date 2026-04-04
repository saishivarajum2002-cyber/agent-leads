const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const axios = require('axios');
require('dotenv').config();
const { sendEmail } = require('./services/email');
const { createGoogleMeeting, getGoogleAuthUrl, getGoogleTokens } = require('./services/google');
const { pushNotification } = require('./services/supabase');

const { generateDescription } = require('./services/ai');


const app = express();
app.use(cors());
app.use(express.json({limit: '50mb'}));
app.use(express.static(__dirname));

// MongoDB Connection
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/propedge';
mongoose.connect(MONGODB_URI)
  .then(() => console.log('MongoDB Connected'))
  .catch(err => console.log('MongoDB Error:', err));

// Schema to store the entire state dynamically for an agent
const DataSnapshotSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true },
  data: { type: Object, default: {} }
}, { timestamps: true });

// Token Storage Schema
const PeTokenSchema = new mongoose.Schema({
  email: { type: String, required: true },
  platform: { type: String, enum: ['zoom', 'google'], required: true },
  access_token: String,
  refresh_token: String,
  expiry: Date
}, { timestamps: true });
PeTokenSchema.index({ email: 1, platform: 1 }, { unique: true });
const PeToken = mongoose.model('PeToken', PeTokenSchema);

const DataSnapshot = mongoose.model('DataSnapshot', DataSnapshotSchema);

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
    
    // Store in database
    await PeToken.findOneAndUpdate(
      { email, platform: 'google' },
      { 
        access_token: tokens.access_token, 
        refresh_token: tokens.refresh_token, 
        expiry: tokens.expiry_date ? new Date(tokens.expiry_date) : null 
      },
      { upsert: true }
    );

    console.log("✅ Real Google integration connected for", email);

    res.send('<script>window.opener.postMessage("google_connected", "*"); window.close();</script>');
  } catch (error) {
    console.error("Google Auth Error:", error);
    res.status(500).send('Google Auth Error: ' + error.message);
  }
});

// 2. Status Check
app.get('/api/integration-status', async (req, res) => {
  const { email } = req.query;
  const tokens = await PeToken.find({ email });
  const status = {
    google: tokens.some(t => t.platform === 'google')
  };
  res.json(status);
});

// 4. Create Meeting
app.post('/api/create-meeting', async (req, res) => {
  const { email, booking } = req.body;
  try {
    // 1. Get Agent's stored Google Token
    const tokenRecord = await PeToken.findOne({ email, platform: 'google' });
    
    // 2. Block if Google is not connected — do not generate fake random links
    if (!tokenRecord || !tokenRecord.access_token || tokenRecord.access_token.startsWith('MOCK_')) {
      return res.status(400).json({ 
        error: 'google_not_connected',
        message: 'Please connect your Google account in Settings to create a real meeting link.'
      });
    }
    
    // 3. Create REAL Google Calendar event with Meet link
    const meetingData = await createGoogleMeeting(booking, tokenRecord);
    
    // 4. Send confirmation email to client
    if (booking.email) {
      await sendEmail({
        to: booking.email,
        subject: `Meeting Confirmed: Tour of ${booking.property_name}`,
        message: `Hi ${booking.client_name},\n\nYour property tour has been confirmed!\n\nDate: ${booking.visit_date}\nTime: ${booking.visit_time}\n\n📹 Join Meeting: ${meetingData.meeting_link}\n\nWe look forward to seeing you!`
      });
    }

    // 5. Send notification to Agent via email too
    await sendEmail({
      to: email,
      subject: `Meeting Created: Tour with ${booking.client_name}`,
      message: `Hi,\n\nA meeting has been created for:\n\nClient: ${booking.client_name}\nDate: ${booking.visit_date}\nTime: ${booking.visit_time}\nGoogle Meet: ${meetingData.meeting_link}\n\nThe client has been notified.`
    });

    // 6. Push Supabase notification
    await pushNotification(email, 'meeting_created', `Meeting scheduled with ${booking.client_name} for ${booking.visit_date}`);

    console.log('✅ Real meeting created for', booking.client_name, ':', meetingData.meeting_link);

    return res.json({ 
      meeting_link: meetingData.meeting_link, 
      meeting_id: meetingData.meeting_id,
      type: 'google'
    });
  } catch (error) {
    console.error('API Error:', error.message);
    res.status(500).json({ error: 'Failed to create meeting: ' + error.message });
  }
});
// AI Tool: Generate Property Description
app.post('/api/ai/description', async (req, res) => {
  try {
    const { details } = req.body;
    if (!details) return res.status(400).json({ error: 'Property details required' });
    
    console.log(`🤖 AI: Generating description for ${details.substring(0, 30)}...`);
    const result = await generateDescription(details);
    
    if (result.success) {
      res.json({ text: result.text });
    } else {
      res.status(500).json({ error: result.error });
    }
  } catch (error) {
    console.error('AI API Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});


// Dedicated Lead Notification Endpoint
app.post('/api/notify-lead', async (req, res) => {
  try {
    const { agentEmail, lead } = req.body;
    if (!agentEmail || !lead) return res.status(400).json({ error: 'agentEmail and lead required' });
    
    console.log(`🔔 Lead notification triggered for ${agentEmail}: ${lead.name}`);
    
    const emailResult = await sendEmail({
      to: agentEmail,
      subject: `🔔 New Lead: ${lead.name}`,
      message: `Hi,\n\nYou have a new lead from your platform!\n\n👤 Name: ${lead.name}\n📞 Phone: ${lead.phone || 'N/A'}\n🏠 Property Interest: ${lead.property_interest || 'N/A'}\n📣 Source: ${lead.source || 'N/A'}\n\nLog in to your dashboard to take action:\nhttp://localhost:5000/propedge_dashboard.html`
    });
    
    await pushNotification(agentEmail, 'new_lead', `New lead: ${lead.name} from ${lead.source}`);
    
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
    res.status(500).json({ error: 'Server Error' });
  }
});

app.post('/api/sync', async (req, res) => {
  try {
    const { email, data } = req.body;
    if (!email || !data) return res.status(400).json({ error: 'Email and data required' });
    
    // Check if there's a new lead to trigger notification
    const oldSnapshot = await DataSnapshot.findOne({ email });
    const oldLeads = oldSnapshot ? (JSON.parse(oldSnapshot.data.pe_leads || '[]')) : [];
    const newLeads = JSON.parse(data.pe_leads || '[]');
    
    if (newLeads.length > oldLeads.length) {
      const latestLead = newLeads[0];
      console.log(`🔔 New lead for ${email}: ${latestLead.name}`);
      
      // Notify Agent via Email
      await sendEmail({
        to: email, // Agent's email from snapshot
        subject: `New Lead: ${latestLead.name}`,
        message: `Hi,\n\nYou have a new lead!\n\nName: ${latestLead.name}\nPhone: ${latestLead.phone}\nProperty: ${latestLead.property_interest}\nSource: ${latestLead.source}\n\nCheck your dashboard for details.`
      });

      // Notify via Supabase
      await pushNotification(email, 'new_lead', `New lead from ${latestLead.source}: ${latestLead.name}`);
    }

    await DataSnapshot.findOneAndUpdate(
      { email },
      { email, data },
      { upsert: true, new: true }
    );
    res.json({ success: true });
  } catch (error) {
    console.error('Sync Error:', error);
    res.status(500).json({ error: 'Server Error' });
  }
});


const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

// Export for versatile Vercel deployment
module.exports = app;
