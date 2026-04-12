const { Resend } = require('resend');
require('dotenv').config();

const resend = new Resend(process.env.RESEND_API_KEY);
// In sandbox mode, Resend only allows sending to the account owner's email.
// Set RESEND_TO_OVERRIDE in .env to route all test emails to that address.
const SANDBOX_EMAIL = process.env.RESEND_TO_OVERRIDE || null;

/**
 * Email Service
 * Fully integrated with Resend API
 */
const sendEmail = async ({ to, subject, message, html }) => {
  if (!process.env.RESEND_API_KEY) {
    console.error('❌ RESEND_API_KEY is missing in environment variables!');
    return { success: false, error: 'Email service is missing: RESEND_API_KEY not configured' };
  }
  try {
    const recipient = to;

    const payload = {
      from: 'PropEdge <notifications@saiwebservices.in>',
      to: [recipient],
      subject: subject,
      text: message,
    };

    // Include HTML if provided
    if (html) payload.html = html;

    const { data, error } = await resend.emails.send(payload);

    if (error) {
      console.error('📧 Resend Error:', JSON.stringify(error));
      return { success: false, error };
    }

    console.log(`📧 Email sent to ${recipient} | Subject: ${subject} | ID: ${data.id}`);
    return { success: true, data };
  } catch (err) {
    console.error('📧 Email Service Exception:', err.message);
    return { success: false, error: err.message };
  }
};

module.exports = { sendEmail };

