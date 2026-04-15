const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, '..')));

require('dotenv').config();
const { sendEmail } = require('../services/email');
const {
  pushNotification, saveLeadToSupabase, saveVisitToSupabase,
  updateVisitInSupabase, deleteVisitFromSupabase, getVisitFromSupabase,
  getVisitsByDate, saveQualification, getQualification, saveAgreement,
  getAgreement, saveDocument, getDocumentsByLead, getAllDocuments, getAllAgreements
} = require('../services/supabase');
const { generateDescription } = require('../services/ai');
const {
  sendBookingCreatedMsg, sendBookingConfirmedMsg, sendVisitReminderMsg, sendNewLeadNotification
} = require('../services/whatsapp');

// ──────────────────────────────────────────────────────────────────────────────
// MONGODB CONNECTION
// ──────────────────────────────────────────────────────────────────────────────
const MONGODB_URI = process.env.MONGODB_URI;
let cachedConnection = null;

const connectDB = async () => {
  if (cachedConnection) return cachedConnection;
  if (!MONGODB_URI) throw new Error('MONGODB_URI is missing in environment variables!');
  try {
    const options = { serverSelectionTimeoutMS: 5000, socketTimeoutMS: 45000 };
    console.log('⏳ Connecting to MongoDB Atlas...');
    cachedConnection = await mongoose.connect(MONGODB_URI, options);
    console.log('✅ MongoDB Connected to Atlas');
    return cachedConnection;
  } catch (err) {
    cachedConnection = null;
    console.error('❌ MongoDB Connection Error:', err.message);
    throw err;
  }
};

app.use(async (req, res, next) => {
  try { await connectDB(); next(); }
  catch (err) {
    res.status(500).json({
      error: 'Database Connection Failed', details: err.message,
      suggestion: err.message.includes('IP not whitelisted')
        ? 'Update MongoDB Atlas Network Access to allow all IPs (0.0.0.0/0)'
        : 'Check environment variables and Atlas status'
    });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// SCHEMAS & MODELS
// ──────────────────────────────────────────────────────────────────────────────
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

const PeToken = mongoose.models.PeToken || mongoose.model('PeToken', PeTokenSchema);
const DataSnapshot = mongoose.models.DataSnapshot || mongoose.model('DataSnapshot', DataSnapshotSchema);

// ──────────────────────────────────────────────────────────────────────────────
// HELPERS
// ──────────────────────────────────────────────────────────────────────────────
function genToken() {
  return crypto.randomBytes(24).toString('hex');
}

function calcQualificationScore(budget, bhkPref, preApproval) {
  let score = 0;
  // Budget
  const budgetMap = { 'Under $500K': 50, '$500K - $1M': 65, '$1M - $3M': 80, '$3M - $10M': 90, '$10M+': 95 };
  score += budgetMap[budget] || 40;
  // Pre-approval
  if (preApproval === 'yes') score += 30;
  else if (preApproval === 'working') score += 15;
  // Score is out of 125 → normalize to 100
  return Math.min(100, Math.round(score * 0.8));
}

// ──────────────────────────────────────────────────────────────────────────────
// INTEGRATION STATUS
// ──────────────────────────────────────────────────────────────────────────────
app.get('/api/integration-status', async (req, res) => {
  const { email } = req.query;
  const tokens = await PeToken.find({ email });
  const status = {
    google: tokens.some(t => t.platform === 'google'),
    whatsapp: !!(process.env.WHATSAPP_ACCESS_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID)
  };
  res.json(status);
});

// ──────────────────────────────────────────────────────────────────────────────
// AVAILABILITY CHECK
// ──────────────────────────────────────────────────────────────────────────────
app.get('/api/availability', async (req, res) => {
  const { date } = req.query;
  if (!date) return res.status(400).json({ error: 'Date is required' });
  try {
    const visits = await getVisitsByDate(date);
    if (visits.success) {
      const busyTimes = visits.data.map(v => v.visit_time.substring(0, 5));
      return res.json({ success: true, busyTimes });
    }
    throw new Error(visits.error);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch availability: ' + error.message });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// AI PRE-QUALIFICATION — POST /api/qualify
// ──────────────────────────────────────────────────────────────────────────────
app.post('/api/qualify', async (req, res) => {
  try {
    const { name, email, phone, budget, bhk_preference, pre_approval_status } = req.body;
    if (!budget || !bhk_preference || !pre_approval_status) {
      return res.status(400).json({ error: 'budget, bhk_preference, and pre_approval_status are required' });
    }

    const score = calcQualificationScore(budget, bhk_preference, pre_approval_status);
    const isQualified = score >= 50; // Threshold for booking eligibility
    const sessionToken = genToken();

    const qualification = {
      session_token: sessionToken,
      name: name || null,
      email: email || null,
      phone: phone || null,
      budget,
      bhk_preference,
      pre_approval_status,
      qualification_score: score,
      is_qualified: isQualified,
      answers: { budget, bhk_preference, pre_approval_status }
    };

    // Save to Supabase
    const result = await saveQualification(qualification);

    // Save to MongoDB as well
    try {
      const agentEmail = 'saishivaraju.m2002@gmail.com';
      let snapshot = await DataSnapshot.findOne({ email: agentEmail });
      if (!snapshot) snapshot = new DataSnapshot({ email: agentEmail, data: {} });
      if (!snapshot.data.pe_qualifications) snapshot.data.pe_qualifications = [];
      snapshot.data.pe_qualifications.unshift({ ...qualification, id: sessionToken, created_at: new Date().toISOString() });
      snapshot.markModified('data');
      await snapshot.save();
    } catch (e) { console.error('MongoDB Qualification Save Error:', e.message); }

    console.log(`🤖 AI Qualification: ${name || 'Anonymous'} — Score: ${score} — Qualified: ${isQualified}`);

    res.json({
      success: true,
      session_token: sessionToken,
      qualification_score: score,
      is_qualified: isQualified,
      message: isQualified
        ? 'Great! You qualify to schedule a property visit.'
        : 'Thank you for your interest. Based on your responses, please contact our agent directly for the best options.'
    });
  } catch (error) {
    console.error('Qualification Error:', error.message);
    res.status(500).json({ error: 'Failed to process qualification: ' + error.message });
  }
});

// GET /api/qualify/:session — check qualification
app.get('/api/qualify/:session', async (req, res) => {
  try {
    const result = await getQualification(req.params.session);
    if (result.success) return res.json({ success: true, data: result.data });
    res.status(404).json({ error: 'Qualification not found' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// BUYER AGREEMENTS — POST /api/agreements
// ──────────────────────────────────────────────────────────────────────────────
app.post('/api/agreements', async (req, res) => {
  try {
    const { signer_name, signer_email, signer_phone, qualification_token, property_name, agreement_text } = req.body;
    if (!signer_name) return res.status(400).json({ error: 'signer_name is required' });
    if (!qualification_token) return res.status(400).json({ error: 'qualification_token is required — complete AI pre-qualification first' });

    // Verify qualification exists and is qualified
    const qualResult = await getQualification(qualification_token);
    if (!qualResult.success) {
      return res.status(400).json({ error: 'Invalid qualification token. Please complete AI pre-qualification first.' });
    }
    if (!qualResult.data.is_qualified) {
      return res.status(403).json({ error: 'Qualification score too low. Please contact the agent directly.' });
    }

    const agreementToken = genToken();
    const agreement = {
      session_token: agreementToken,
      signer_name,
      signer_email: signer_email || qualResult.data.email,
      signer_phone: signer_phone || qualResult.data.phone,
      ip_address: req.headers['x-forwarded-for'] || req.socket.remoteAddress,
      signed_at: new Date().toISOString(),
      agreement_text: agreement_text || 'Buyer Representation Agreement v1.0',
      property_name: property_name || null,
      qualification_id: qualification_token
    };

    const result = await saveAgreement(agreement);

    // Auto-create Agreement document in document vault
    if (result.success && result.data) {
      const docText = `BUYER REPRESENTATION AGREEMENT\n\nSigned by: ${signer_name}\nEmail: ${agreement.signer_email || 'N/A'}\nPhone: ${agreement.signer_phone || 'N/A'}\nProperty: ${property_name || 'N/A'}\nDate: ${new Date().toISOString()}\nAgreement Version: v1.0\n\nI, ${signer_name}, acknowledge and agree to the Buyer Representation Agreement with PropEdge Real Estate.`;
      await saveDocument({
        agreement_id: result.data.id,
        doc_type: 'agreement',
        file_name: `BRA_${signer_name.replace(/\s+/g, '_')}_${new Date().toISOString().split('T')[0]}.txt`,
        file_data: Buffer.from(docText).toString('base64'),
        file_mime: 'text/plain',
        file_size_kb: Math.round(docText.length / 1024) || 1,
        uploader: 'buyer',
        notes: `Auto-generated Buyer Representation Agreement for ${signer_name}`
      });
    }

    // Notify agent via email
    try {
      await sendEmail({
        to: 'saishivaraju.m2002@gmail.com',
        subject: `📝 Buyer Agreement Signed: ${signer_name}`,
        message: `${signer_name} has signed the Buyer Representation Agreement.\n\nEmail: ${signer_email || 'N/A'}\nPhone: ${signer_phone || 'N/A'}\nProperty Interest: ${property_name || 'N/A'}\nSigned At: ${new Date().toISOString()}\n\nAgreement Token: ${agreementToken}`
      });
    } catch (e) { console.error('Agreement Email Error:', e.message); }

    console.log(`📝 Agreement Signed: ${signer_name} — Token: ${agreementToken}`);
    res.json({ success: true, agreement_token: agreementToken, message: 'Agreement signed successfully. You may now book your visit.' });
  } catch (error) {
    console.error('Agreement Error:', error.message);
    res.status(500).json({ error: 'Failed to save agreement: ' + error.message });
  }
});

// GET /api/agreements/:session — retrieve agreement
app.get('/api/agreements/:session', async (req, res) => {
  try {
    const result = await getAgreement(req.params.session);
    if (result.success) return res.json({ success: true, data: result.data });
    res.status(404).json({ error: 'Agreement not found' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// DOCUMENTS — POST /api/documents
// ──────────────────────────────────────────────────────────────────────────────
app.post('/api/documents', async (req, res) => {
  try {
    const { lead_id, visit_id, agreement_id, doc_type, file_name, file_data, file_mime, file_size_kb, notes, uploader } = req.body;
    if (!file_name || !doc_type) return res.status(400).json({ error: 'file_name and doc_type are required' });

    const result = await saveDocument({ lead_id, visit_id, agreement_id, doc_type, file_name, file_data, file_mime, file_size_kb, notes, uploader });
    if (result.success) {
      console.log(`📄 Document saved: ${file_name} (${doc_type})`);
      return res.json({ success: true, id: result.data.id, message: 'Document stored securely.' });
    }
    res.status(500).json({ error: result.error });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/documents/:leadId — documents for a lead
app.get('/api/documents/:leadId', async (req, res) => {
  try {
    const result = await getDocumentsByLead(req.params.leadId);
    if (result.success) return res.json({ success: true, data: result.data });
    res.status(500).json({ error: result.error });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/documents — all documents (agent dashboard)
app.get('/api/documents', async (req, res) => {
  try {
    const result = await getAllDocuments();
    if (result.success) return res.json({ success: true, data: result.data });
    res.status(500).json({ error: result.error });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/all-agreements — all agreements (agent dashboard)
app.get('/api/all-agreements', async (req, res) => {
  try {
    const result = await getAllAgreements();
    if (result.success) return res.json({ success: true, data: result.data });
    res.status(500).json({ error: result.error });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// WHATSAPP — POST /api/whatsapp
// ──────────────────────────────────────────────────────────────────────────────
app.post('/api/whatsapp', async (req, res) => {
  try {
    const { to, message, type, visit } = req.body;
    if (!to) return res.status(400).json({ error: 'Recipient phone number (to) is required' });

    let result;
    if (type === 'booking_created' && visit) result = await sendBookingCreatedMsg(to, visit);
    else if (type === 'booking_confirmed' && visit) result = await sendBookingConfirmedMsg(to, visit);
    else if (type === 'reminder' && visit) result = await sendVisitReminderMsg(to, visit);
    else if (message) {
      const { sendWhatsAppText } = require('../services/whatsapp');
      result = await sendWhatsAppText(to, message);
    } else {
      return res.status(400).json({ error: 'Provide either "message" or "type" + "visit"' });
    }

    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// PROPERTY VISITS — POST /api/visits (gated by qualification + agreement)
// ──────────────────────────────────────────────────────────────────────────────
app.post('/api/visits', async (req, res) => {
  const { agentEmail, visit } = req.body;
  try {
    if (!agentEmail || !visit) return res.status(400).json({ error: 'agentEmail and visit required' });

    // ── GATE 1: Qualification Check
    if (visit.qualification_token) {
      const qualRes = await getQualification(visit.qualification_token);
      if (!qualRes.success) {
        return res.status(403).json({ error: 'Invalid qualification. Please complete AI pre-qualification first.', code: 'QUAL_REQUIRED' });
      }
      if (!qualRes.data.is_qualified) {
        return res.status(403).json({ error: 'Qualification score too low to book online. Please contact agent.', code: 'QUAL_FAILED' });
      }
    }

    // ── GATE 2: Agreement Check
    if (visit.agreement_token) {
      const agreeRes = await getAgreement(visit.agreement_token);
      if (!agreeRes.success) {
        return res.status(403).json({ error: 'Buyer Agreement not found. Please sign the agreement first.', code: 'AGREE_REQUIRED' });
      }
    }

    // ── Double Booking Check
    const availability = await getVisitsByDate(visit.visit_date);
    if (availability.success) {
      const isBooked = availability.data.some(v => {
        const vTime = String(v.visit_time).substring(0, 5);
        const reqTime = String(visit.visit_time).substring(0, 5);
        return vTime === reqTime;
      });
      if (isBooked) return res.status(409).json({ error: 'This time slot is already booked. Please choose another time.' });
    }

    // ── Save to Supabase
    const { success: supabaseSaved, data: savedVisit, error: supabaseError } = await saveVisitToSupabase({
      ...visit,
      agreement_id: visit.agreement_token || null,
      qualification_id: visit.qualification_token || null,
      status: visit.status || 'pending',
      created_at: new Date().toISOString()
    });

    if (!supabaseSaved) {
      console.error('❌ Supabase Save Failure:', supabaseError);
      return res.status(500).json({ error: 'Database Save Failed: ' + supabaseError });
    }

    const realId = savedVisit.id;
    console.log(`📌 Generated Supabase Visit ID: ${realId}`);

    // ── Save to MongoDB
    let mongodbSaved = false;
    try {
      let snapshot = await DataSnapshot.findOne({ email: agentEmail });
      if (!snapshot) snapshot = new DataSnapshot({ email: agentEmail, data: { pe_bookings: [] } });
      
      let bookings = snapshot.data.pe_bookings || [];
      // Handle the case where the frontend stored this as a stringified JSON in MongoDB
      if (typeof bookings === 'string') {
        try { bookings = JSON.parse(bookings); } catch(e) { bookings = []; }
      }
      
      const newVisit = { ...visit, id: realId, status: visit.status || 'pending', created_at: new Date().toISOString() };
      bookings.unshift(newVisit);
      
      // Keep it consistent with dashboard's preference if it was a string
      snapshot.data.pe_bookings = typeof snapshot.data.pe_bookings === 'string' 
        ? JSON.stringify(bookings) 
        : bookings;
        
      snapshot.markModified('data');
      await snapshot.save();
      mongodbSaved = true;
    } catch (e) { console.error('MongoDB Visit Error:', e.message); }

    // ── Agent Email Alert
    console.log(`📧 API: Sending Agent Alert to [${agentEmail}]`);
    const agentAlertResult = await sendEmail({
      to: agentEmail,
      subject: `🔔 New Visit Request: ${visit.client_name} → ${visit.property_name}`,
      message: `New property visit request received!\n\n📌 Property: ${visit.property_name}\n👤 Client: ${visit.client_name}\n📧 Email: ${visit.client_email || 'N/A'}\n📞 Phone: ${visit.client_phone || 'N/A'}\n📅 Date: ${visit.visit_date}\n🕒 Time: ${visit.visit_time}\n✅ Agreement Signed: ${visit.agreement_token ? 'YES' : 'No'}\n🤖 Pre-Qualified: ${visit.qualification_token ? 'YES' : 'No'}\n\nDashboard: https://agent-leads.vercel.app/propedge_dashboard.html`,
      html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#f9f9f9;border-radius:8px;overflow:hidden"><div style="background:#1a1a18;padding:24px;text-align:center"><h2 style="color:#d4b483;margin:0;font-size:22px">🔔 New Visit Request</h2></div><div style="background:#fff;padding:24px"><p style="color:#333;margin-top:0">Hi Sai Shiva,</p><p style="color:#555">A new property visit has been requested. Please review and confirm or reject it from your dashboard.</p><table style="width:100%;border-collapse:collapse;margin:16px 0"><tr style="background:#f5f5f5"><td style="padding:10px;border:1px solid #ddd;font-weight:bold;color:#333;width:35%">🏠 Property</td><td style="padding:10px;border:1px solid #ddd;color:#555">${visit.property_name}</td></tr><tr><td style="padding:10px;border:1px solid #ddd;font-weight:bold;color:#333">👤 Client</td><td style="padding:10px;border:1px solid #ddd;color:#555">${visit.client_name}</td></tr><tr style="background:#f5f5f5"><td style="padding:10px;border:1px solid #ddd;font-weight:bold;color:#333">📧 Email</td><td style="padding:10px;border:1px solid #ddd;color:#555">${visit.client_email || 'N/A'}</td></tr><tr><td style="padding:10px;border:1px solid #ddd;font-weight:bold;color:#333">📞 Phone</td><td style="padding:10px;border:1px solid #ddd;color:#555">${visit.client_phone || 'N/A'}</td></tr><tr style="background:#f5f5f5"><td style="padding:10px;border:1px solid #ddd;font-weight:bold;color:#333">📅 Date</td><td style="padding:10px;border:1px solid #ddd;color:#555">${visit.visit_date}</td></tr><tr><td style="padding:10px;border:1px solid #ddd;font-weight:bold;color:#333">🕒 Time</td><td style="padding:10px;border:1px solid #ddd;color:#555">${visit.visit_time}</td></tr><tr style="background:#f5f5f5"><td style="padding:10px;border:1px solid #ddd;font-weight:bold;color:#333">✅ Agreement</td><td style="padding:10px;border:1px solid #ddd;color:${visit.agreement_token ? '#2ecc71' : '#e74c3c'}">${visit.agreement_token ? '✅ Signed' : '❌ Not signed'}</td></tr><tr><td style="padding:10px;border:1px solid #ddd;font-weight:bold;color:#333">🤖 Pre-Qualified</td><td style="padding:10px;border:1px solid #ddd;color:${visit.qualification_token ? '#2ecc71' : '#e74c3c'}">${visit.qualification_token ? '✅ Yes' : '❌ No'}</td></tr></table><div style="text-align:center;margin-top:20px"><a href="https://agent-leads.vercel.app/propedge_dashboard.html" style="background:#b8965a;color:#fff;padding:12px 28px;text-decoration:none;border-radius:6px;font-weight:bold;display:inline-block">Open Dashboard →</a></div></div><div style="background:#1a1a18;padding:14px;text-align:center"><p style="color:#888;font-size:12px;margin:0">PropEdge • saishivaraju.m2002@gmail.com</p></div></div>`
    });
    console.log(`📧 Agent Alert: ${agentAlertResult.success ? 'SUCCESS' : 'FAILED'}`);

    // ── Client Confirmation Email
    if (visit.client_email) {
      console.log(`📧 Sending Client Confirmation to [${visit.client_email}]`);
      await sendEmail({
        to: visit.client_email,
        subject: `✅ Visit Request Received: ${visit.property_name}`,
        message: `Hi ${visit.client_name},\n\nYour visit request has been received and is pending agent approval.\n\n📌 Property: ${visit.property_name}\n📅 Date: ${visit.visit_date}\n🕒 Time: ${visit.visit_time}\n✅ Agreement: ${visit.agreement_token ? 'Signed' : 'N/A'}\n\nWe will email you once your visit is confirmed.\n\nAgent: saishivaraju.m2002@gmail.com`,
        html: `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#f9f9f9;border-radius:8px;overflow:hidden"><div style="background:#1a1a18;padding:24px;text-align:center"><h2 style="color:#d4b483;margin:0">Visit Request Received</h2></div><div style="background:#fff;padding:24px"><p style="color:#333;margin-top:0">Hi ${visit.client_name},</p><p style="color:#555">Thank you! Your property visit request has been received. The agent will confirm your booking shortly.</p><div style="background:#fffbf0;border:1px solid #d4b483;border-radius:6px;padding:16px;margin:16px 0"><p style="margin:0 0 8px;font-weight:bold;color:#333">📋 Your Booking Details</p><p style="margin:4px 0;color:#555"><strong>Property:</strong> ${visit.property_name}</p><p style="margin:4px 0;color:#555"><strong>Date:</strong> ${visit.visit_date}</p><p style="margin:4px 0;color:#555"><strong>Time:</strong> ${visit.visit_time}</p><p style="margin:4px 0;color:#f0a030"><strong>Status:</strong> ⏳ Pending Confirmation</p>${visit.agreement_token ? '<p style="margin:4px 0;color:#2ecc71"><strong>Agreement:</strong> ✅ Signed</p>' : ''}</div><p style="color:#777;font-size:13px">We will send you another email once the agent confirms your visit.</p></div><div style="background:#1a1a18;padding:14px;text-align:center"><p style="color:#888;font-size:12px;margin:0">PropEdge Real Estate</p></div></div>`
      });
    }

    // ── WhatsApp Notification to Client
    if (visit.client_phone) {
      try {
        const waResult = await sendBookingCreatedMsg(visit.client_phone, { ...visit, id: realId });
        if (waResult.success) {
          await updateVisitInSupabase(realId, { whatsapp_sent: true });
        }
      } catch (e) { console.error('WhatsApp Error:', e.message); }
    }

    // ── Save Dashboard Notification
    try {
      let snapshot = await DataSnapshot.findOne({ email: agentEmail });
      if (snapshot) {
        if (!snapshot.data.pe_notifications) snapshot.data.pe_notifications = [];
        snapshot.data.pe_notifications.unshift({
          id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
          title: 'Tour Request: ' + visit.client_name,
          description: `Wants to visit ${visit.property_name} · ${visit.visit_date} ${visit.visit_time}`,
          type: 'booking', bookingId: realId, icon: '📅', is_read: false,
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

// ──────────────────────────────────────────────────────────────────────────────
// UPDATE VISIT — PATCH /api/visits/:id
// ──────────────────────────────────────────────────────────────────────────────
app.patch('/api/visits/:id', async (req, res) => {
  const { id } = req.params;
  const { agentEmail, updates } = req.body;
  if (updates && updates.status) updates.status = updates.status.toLowerCase();

  try {
    const supabaseResult = await updateVisitInSupabase(id, updates);

    if (agentEmail) {
      const snapshot = await DataSnapshot.findOne({ email: agentEmail });
      if (snapshot && snapshot.data.pe_bookings) {
        const idx = snapshot.data.pe_bookings.findIndex(v => v.id === id);
        if (idx !== -1) {
          snapshot.data.pe_bookings[idx] = { ...snapshot.data.pe_bookings[idx], ...updates };
          snapshot.markModified('data');
          await snapshot.save();
        }
      }
    }

    try {
      const visitRes = await getVisitFromSupabase(id);
      if (visitRes.success) {
        const v = visitRes.data;
        const isConfirmed = String(updates.status || '').toLowerCase() === 'confirmed';
        const isRejected = String(updates.status || '').toLowerCase() === 'rejected';

        if ((isConfirmed || isRejected) && v.client_email) {
          const confirmSubject = isConfirmed
            ? `✅ Your visit is CONFIRMED: ${v.property_name}`
            : `❌ Visit Not Available: ${v.property_name}`;
          const confirmHtml = isConfirmed
            ? `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#f9f9f9;border-radius:8px;overflow:hidden"><div style="background:#1a1a18;padding:24px;text-align:center"><h2 style="color:#2ecc8a;margin:0">✅ Visit Confirmed!</h2></div><div style="background:#fff;padding:24px"><p style="color:#333;margin-top:0">Hi ${v.client_name},</p><p style="color:#555">Your property visit has been <strong style="color:#2ecc8a">confirmed</strong>. We look forward to seeing you!</p><div style="background:#f0fdf8;border:1px solid #2ecc8a;border-radius:6px;padding:16px;margin:16px 0"><p style="margin:0 0 8px;font-weight:bold;color:#333">📋 Booking Confirmation</p><p style="margin:4px 0;color:#555"><strong>Property:</strong> ${v.property_name}</p><p style="margin:4px 0;color:#555"><strong>Date:</strong> ${v.visit_date}</p><p style="margin:4px 0;color:#555"><strong>Time:</strong> ${v.visit_time}</p><p style="margin:4px 0;color:#2ecc8a"><strong>Status:</strong> ✅ Confirmed</p></div><p style="color:#333;font-weight:bold">Your Agent:</p><p style="color:#555;margin:4px 0">👤 Sai Shiva</p><p style="color:#555;margin:4px 0">📧 saishivaraju.m2002@gmail.com</p><p style="color:#555;margin:4px 0">📞 +971 50 123 4567</p></div><div style="background:#1a1a18;padding:14px;text-align:center"><p style="color:#888;font-size:12px;margin:0">PropEdge Real Estate</p></div></div>`
            : `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto"><div style="background:#1a1a18;padding:24px;text-align:center"><h2 style="color:#e05060;margin:0">Visit Not Available</h2></div><div style="background:#fff;padding:24px"><p>Hi ${v.client_name},</p><p>Unfortunately the visit slot for <strong>${v.property_name}</strong> (${v.visit_date} at ${v.visit_time}) is not available.</p><p>Please visit our website to request a new date and time.</p></div></div>`;

          console.log(`📧 Sending ${isConfirmed ? 'CONFIRMED' : 'REJECTED'} email to [${v.client_email}]`);
          await sendEmail({ to: v.client_email, subject: confirmSubject, html: confirmHtml, message: confirmSubject });

          // WhatsApp follow-up on confirmation
          if (isConfirmed && v.client_phone) {
            try { await sendBookingConfirmedMsg(v.client_phone, v); } catch (e) {}
          }
        }

        // Dashboard notification
        if (agentEmail && (isConfirmed || isRejected)) {
          try {
            let snapshot = await DataSnapshot.findOne({ email: agentEmail });
            if (snapshot) {
              if (!snapshot.data.pe_notifications) snapshot.data.pe_notifications = [];
              snapshot.data.pe_notifications.unshift({
                id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
                title: `Visit ${isConfirmed ? 'Confirmed' : 'Rejected'}: ${v.client_name}`,
                description: `${v.property_name} · ${v.visit_date} ${v.visit_time}`,
                type: 'booking', icon: isConfirmed ? '✅' : '❌', is_read: false,
                created_at: new Date().toISOString()
              });
              snapshot.markModified('data');
              await snapshot.save();
            }
          } catch (e) {}
        }
      }
    } catch (e) { console.error('Notification Error in PATCH:', e.message); }

    res.json({ success: true, supabaseUpdated: supabaseResult.success });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update visit: ' + error.message });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// AUTOMATED REMINDERS — GET /api/cron/reminders
// ──────────────────────────────────────────────────────────────────────────────
app.get('/api/cron/reminders', async (req, res) => {
  try {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const dateStr = tomorrow.toISOString().split('T')[0];
    
    console.log(`⏰ Running Reminders Cron for: ${dateStr}`);
    
    const visits = await getVisitsByDate(dateStr);
    if (!visits.success || !visits.data.length) {
      return res.json({ success: true, message: 'No visits scheduled for tomorrow.' });
    }

    let sentCount = 0;
    for (const v of visits.data) {
      if (v.status === 'confirmed' && v.client_email) {
        const reminderHtml = `
          <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#f9f9f9;border-radius:8px;overflow:hidden">
            <div style="background:#1a1a18;padding:24px;text-align:center"><h2 style="color:#d4b483;margin:0">⏰ Visit Reminder: Tomorrow</h2></div>
            <div style="background:#fff;padding:24px">
              <p style="color:#333;margin-top:0">Hi ${v.client_name},</p>
              <p style="color:#555">This is a reminder for your property visit scheduled for <strong>tomorrow</strong>.</p>
              <div style="background:#fffbf0;border:1px solid #d4b483;border-radius:6px;padding:16px;margin:16px 0">
                <p style="margin:4px 0;color:#555"><strong>Property:</strong> ${v.property_name}</p>
                <p style="margin:4px 0;color:#555"><strong>Date:</strong> ${v.visit_date}</p>
                <p style="margin:4px 0;color:#555"><strong>Time:</strong> ${v.visit_time}</p>
                <p style="margin:4px 0;color:#2ecc8a"><strong>Status:</strong> Confirmed</p>
              </div>
              <p style="color:#333;font-weight:bold">Contact Details:</p>
              <p style="color:#555;margin:4px 0">👤 Agent: Sai Shiva</p>
              <p style="color:#555;margin:4px 0">📞 +971 50 123 4567</p>
              <p style="color:#555;margin:4px 0">📧 saishivaraju.m2002@gmail.com</p>
              <div style="text-align:center;margin-top:20px">
                <a href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(v.property_name + ' Dubai')}" style="background:#b8965a;color:#fff;padding:12px 28px;text-decoration:none;border-radius:6px;font-weight:bold;display:inline-block">View Location on Maps →</a>
              </div>
            </div>
            <div style="background:#1a1a18;padding:14px;text-align:center"><p style="color:#888;font-size:12px;margin:0">PropEdge Real Estate</p></div>
          </div>`;
        
        await sendEmail({
          to: v.client_email,
          subject: `⏰ Reminder: Your visit to ${v.property_name} is tomorrow`,
          html: reminderHtml,
          message: `Reminder: Your visit to ${v.property_name} is tomorrow at ${v.visit_time}. Location: Dubai.`
        });
        sentCount++;
      }
    }

    res.json({ success: true, sentCount });
  } catch (error) {
    console.error('Cron Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// DELETE VISIT — DELETE /api/visits/:id
// ──────────────────────────────────────────────────────────────────────────────
app.delete('/api/visits/:id', async (req, res) => {
  const { id } = req.params;
  const { agentEmail } = req.query;
  try {
    const supabaseResult = await deleteVisitFromSupabase(id);
    if (agentEmail) {
      await connectDB();
      let snapshot = await DataSnapshot.findOne({ email: agentEmail });
      if (snapshot && snapshot.data.pe_bookings) {
        let bookings = snapshot.data.pe_bookings;
        let wasString = typeof bookings === 'string';
        if (wasString) {
          try { bookings = JSON.parse(bookings); } catch(e) { bookings = []; }
        }
        
        if (Array.isArray(bookings)) {
          snapshot.data.pe_bookings = bookings.filter(v => v.id !== id);
          if (wasString) snapshot.data.pe_bookings = JSON.stringify(snapshot.data.pe_bookings);
          snapshot.markModified('data');
          await snapshot.save();
        }
      }
    }
    res.json({ success: true, supabaseDeleted: supabaseResult.success });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete visit: ' + error.message });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// EMAIL
// ──────────────────────────────────────────────────────────────────────────────
app.get('/api/send-email', (req, res) => res.json({ message: 'Email service ready' }));

app.post('/api/send-email', async (req, res) => {
  try {
    const { to, subject, message } = req.body;
    if (!to || !subject || !message) return res.status(400).json({ error: 'to, subject, and message are required' });
    const result = await sendEmail({ to, subject, message });
    if (result.success) res.json({ success: true, data: result.data });
    else res.status(500).json({ error: result.error });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// AI — Property Description
// ──────────────────────────────────────────────────────────────────────────────
app.post('/api/ai/description', async (req, res) => {
  try {
    const { details } = req.body;
    if (!details) return res.status(400).json({ error: 'Property details required' });
    const result = await generateDescription(details);
    if (result.success) res.json({ text: result.text });
    else res.status(500).json({ error: result.error });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// LEADS — POST /api/leads
// ──────────────────────────────────────────────────────────────────────────────
app.post('/api/leads', async (req, res) => {
  try {
    const { agentEmail, lead } = req.body;
    if (!agentEmail || !lead) return res.status(400).json({ error: 'agentEmail and lead required' });
    console.log(`📩 Processing lead for ${agentEmail}: ${lead.name}`);

    let supabaseResult = { success: false, error: 'Not attempted' };
    try { supabaseResult = await saveLeadToSupabase(lead); }
    catch (e) { console.error('Supabase Error:', e.message); }

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

    let emailResult = { success: false, error: 'Not attempted' };
    try {
      emailResult = await sendEmail({
        to: agentEmail,
        subject: `🔔 New Lead: ${lead.name}`,
        message: `Hi,\n\nYou have a new lead!\n\n👤 Name: ${lead.name}\n📞 Phone: ${lead.phone || 'N/A'}\n📧 Email: ${lead.email || 'N/A'}\n🏠 Interest: ${lead.property_interest || 'N/A'}\n💰 Budget: ${lead.budget || 'N/A'}\n🛏️ BHK: ${lead.bhk_preference || 'N/A'}\n✅ Pre-Approved: ${lead.pre_approval_status || 'N/A'}\n📝 Notes: ${lead.notes || 'N/A'}\n\nLog in to your dashboard to take action.`
      });
    } catch (e) { emailResult.error = e.message; }

    // WhatsApp to agent if phone configured
    try { await sendNewLeadNotification('+919999999999', lead); } catch (e) {}

    const isSuccess = emailResult.success || supabaseResult.success || mongodbSaved;
    if (!isSuccess) return res.status(500).json({ success: false, error: 'Failed to process lead: all systems failed.' });

    try { await pushNotification(agentEmail, 'new_lead', `New lead: ${lead.name}`); } catch (e) {}

    res.json({
      success: isSuccess,
      supabaseSaved: supabaseResult.success,
      mongodbSaved,
      emailSent: emailResult.success,
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

// ──────────────────────────────────────────────────────────────────────────────
// LEGACY — notify-lead
// ──────────────────────────────────────────────────────────────────────────────
app.post('/api/notify-lead', async (req, res) => {
  try {
    const { agentEmail, lead } = req.body;
    if (!agentEmail || !lead) return res.status(400).json({ error: 'agentEmail and lead required' });
    const emailResult = await sendEmail({
      to: agentEmail,
      subject: `🔔 New Lead: ${lead.name}`,
      message: `New lead!\n\n👤 Name: ${lead.name}\n📞 Phone: ${lead.phone || 'N/A'}\n🏠 Property Interest: ${lead.property_interest || 'N/A'}`
    });
    try {
      let snapshot = await DataSnapshot.findOne({ email: agentEmail });
      if (snapshot) {
        if (!snapshot.data.pe_leads) snapshot.data.pe_leads = [];
        let leads = snapshot.data.pe_leads;
        let wasString = typeof leads === 'string';
        if (wasString) {
          try { leads = JSON.parse(leads); } catch(e) { leads = []; }
        }
        
        if (Array.isArray(leads)) {
          leads.unshift(lead);
          snapshot.data.pe_leads = wasString ? JSON.stringify(leads) : leads;
          snapshot.markModified('data');
          await snapshot.save();
        }
      }
    } catch (e) { }
    await pushNotification(agentEmail, 'new_lead', `New lead: ${lead.name}`);
    res.json({ success: true, emailSent: emailResult.success });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// SYNC
// ──────────────────────────────────────────────────────────────────────────────
app.get('/api/sync', async (req, res) => {
  try {
    const { email } = req.query;
    if (!email) return res.status(400).json({ error: 'Email required' });
    const snapshot = await DataSnapshot.findOne({ email });
    res.json(snapshot && snapshot.data ? snapshot.data : {});
  } catch (error) {
    res.status(500).json({ error: 'Database Error: ' + error.message });
  }
});

app.post('/api/sync', async (req, res) => {
  try {
    const { email, data } = req.body;
    if (!email || !data) return res.status(400).json({ error: 'Email and data required' });
    await DataSnapshot.findOneAndUpdate({ email }, { email, data }, { upsert: true });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Database Error: ' + error.message });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// SERVER
// ──────────────────────────────────────────────────────────────────────────────
if (process.env.NODE_ENV !== 'production' && !process.env.VERCEL) {
  const PORT = process.env.PORT || 5000;
  app.listen(PORT, () => console.log(`🚀 PropEdge Server running on port ${PORT}`));
}

module.exports = app;
