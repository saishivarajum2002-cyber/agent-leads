/**
 * WhatsApp Service — Meta WhatsApp Business Cloud API
 * No Twilio, no third-party software. Direct HTTP calls to Meta Graph API.
 * 
 * Setup (free):
 *  1. Create a Meta Developer App at developers.facebook.com
 *  2. Add WhatsApp product → get your Phone Number ID + Access Token
 *  3. Set WHATSAPP_ACCESS_TOKEN and WHATSAPP_PHONE_NUMBER_ID in .env
 *
 * Without env vars: messages are logged to console (silent fallback)
 */

const https = require('https');

const WA_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const WA_PHONE_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const WA_API_VERSION = 'v19.0';

/**
 * Sanitize phone number to E.164 format
 * Accepts: +971501234567 | 971501234567 | 0501234567
 */
function normalizePhone(phone) {
  if (!phone) return null;
  let p = String(phone).replace(/[\s\-().]/g, '');
  // Remove leading 00 country code prefix
  if (p.startsWith('00')) p = '+' + p.slice(2);
  // Add + if missing but starts with country code
  if (!p.startsWith('+') && p.length >= 10) p = '+' + p;
  // Validate: must be + followed by 7-15 digits
  if (/^\+[1-9]\d{6,14}$/.test(p)) return p.replace('+', '');
  return null;
}

/**
 * Core Meta API call
 */
function callMetaAPI(phoneNumber, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const options = {
      hostname: 'graph.facebook.com',
      path: `/${WA_API_VERSION}/${WA_PHONE_ID}/messages`,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${WA_TOKEN}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode === 200 || res.statusCode === 201) {
            resolve({ success: true, data: parsed });
          } else {
            resolve({ success: false, error: parsed.error?.message || data, statusCode: res.statusCode });
          }
        } catch (e) {
          resolve({ success: false, error: 'JSON parse error: ' + data });
        }
      });
    });
    req.on('error', err => resolve({ success: false, error: err.message }));
    req.write(body);
    req.end();
  });
}

/**
 * Send a free-form text WhatsApp message
 */
async function sendWhatsAppText(to, text) {
  const phone = normalizePhone(to);
  if (!phone) {
    console.warn(`⚠️ WhatsApp: Invalid phone number "${to}"`);
    return { success: false, error: 'Invalid phone number' };
  }

  // If Meta API not configured → log and return graceful success
  if (!WA_TOKEN || !WA_PHONE_ID) {
    console.log(`📱 [WhatsApp-SIMULATION] To: +${phone}\n${text}\n`);
    return { success: true, simulated: true };
  }

  const payload = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: phone,
    type: 'text',
    text: { preview_url: true, body: text }
  };

  console.log(`📱 WhatsApp: Sending to +${phone}...`);
  const result = await callMetaAPI(phone, payload);
  if (result.success) {
    console.log(`✅ WhatsApp sent to +${phone}`);
  } else {
    console.error(`❌ WhatsApp failed to +${phone}: ${result.error}`);
  }
  return result;
}

// ─── Message Templates ────────────────────────────────────────────────────────

/**
 * Booking Created — sent to client when booking is submitted
 */
async function sendBookingCreatedMsg(clientPhone, visit) {
  const mapsLink = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(visit.property_name + ' Dubai')}`;
  const msg =
`🏠 *PropEdge Real Estate*

Hi ${visit.client_name},

✅ Your visit request has been *received*!

📌 *Property:* ${visit.property_name}
📅 *Date:* ${visit.visit_date}
🕒 *Time:* ${visit.visit_time}
⏳ *Status:* Pending Confirmation

📍 *Location:* ${mapsLink}

We will confirm your visit shortly. For urgent queries contact your agent directly.

_PropEdge — Smart Real Estate Platform_`;
  return sendWhatsAppText(clientPhone, msg);
}

/**
 * Booking Confirmed — sent to client when agent confirms
 */
async function sendBookingConfirmedMsg(clientPhone, visit) {
  const mapsLink = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(visit.property_name + ' Dubai')}`;
  const virtualTourLink = visit.virtual_tour_link || 'https://agent-leads.vercel.app';
  const msg =
`🏠 *PropEdge Real Estate*

Hi ${visit.client_name},

🎉 Your property visit has been *CONFIRMED*!

📌 *Property:* ${visit.property_name}
📅 *Date:* ${visit.visit_date}
🕒 *Time:* ${visit.visit_time}
✅ *Status:* Confirmed

📍 *Location:* ${mapsLink}
🎬 *Virtual Tour:* ${virtualTourLink}

👤 *Your Agent:* Sai Shiva
📞 *Agent Phone:* +971 50 123 4567
📧 *Agent Email:* saishivaraju.m2002@gmail.com

We look forward to seeing you! 🔑

_PropEdge — Smart Real Estate Platform_`;
  return sendWhatsAppText(clientPhone, msg);
}

/**
 * Visit Reminder — sent 24 hours before the visit
 */
async function sendVisitReminderMsg(clientPhone, visit) {
  const mapsLink = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(visit.property_name + ' Dubai')}`;
  const msg =
`🏠 *PropEdge Real Estate — Reminder*

Hi ${visit.client_name},

⏰ *Reminder:* Your property visit is *tomorrow*!

📌 *Property:* ${visit.property_name}
📅 *Date:* ${visit.visit_date}
🕒 *Time:* ${visit.visit_time}

📍 *Location (Google Maps):* ${mapsLink}

Please arrive 5 minutes early. Contact your agent if you need to reschedule.

👤 Agent: Sai Shiva | 📞 +971 50 123 4567

_PropEdge — Smart Real Estate Platform_`;
  return sendWhatsAppText(clientPhone, msg);
}

/**
 * New Lead Notification — sent to agent
 */
async function sendNewLeadNotification(agentPhone, lead) {
  const msg =
`⚡ *PropEdge — New Lead Alert*

A new potential buyer just submitted a query!

👤 *Name:* ${lead.name}
📞 *Phone:* ${lead.phone || 'N/A'}
📧 *Email:* ${lead.email || 'N/A'}
🏠 *Interest:* ${lead.property_interest || 'Not specified'}
💰 *Budget:* ${lead.budget || 'Not specified'}
🛏️ *BHK Pref:* ${lead.bhk_preference || 'Not specified'}
✅ *Pre-Approved:* ${lead.pre_approval_status || 'Unknown'}

🔗 Dashboard: https://agent-leads.vercel.app/propedge_dashboard.html

_PropEdge CRM_`;
  return sendWhatsAppText(agentPhone, msg);
}

module.exports = {
  sendWhatsAppText,
  sendBookingCreatedMsg,
  sendBookingConfirmedMsg,
  sendVisitReminderMsg,
  sendNewLeadNotification
};
