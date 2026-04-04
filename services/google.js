const { google } = require('googleapis');

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI
);

const getGoogleAuthUrl = (email) => {
  return oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: ['https://www.googleapis.com/auth/calendar.events'],
    state: email
  });
};

const getGoogleTokens = async (code) => {
  const { tokens } = await oauth2Client.getToken(code);
  return tokens;
};

/**
 * Google Service
 * Fully integrated with Google Calendar/Meet API
 * Supports per-agent tokens
 */
const createGoogleMeeting = async (bookingData, agentTokenRecord) => {
  if (!agentTokenRecord || !agentTokenRecord.access_token) {
    console.warn('⚠️ No agent token provided. Returning mock link.');
    return {
      meeting_link: "https://meet.google.com/connect-google-first",
      meeting_id: "pending-" + Date.now()
    };
  }

  try {
    oauth2Client.setCredentials({
      access_token: agentTokenRecord.access_token,
      refresh_token: agentTokenRecord.refresh_token,
      expiry_date: agentTokenRecord.expiry ? new Date(agentTokenRecord.expiry).getTime() : null
    });

    const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
    
    // Parse the date and time to proper ISO string
    const startDateTime = new Date(`${bookingData.visit_date}T${bookingData.visit_time}:00`);
    const endDateTime = new Date(startDateTime.getTime() + 45 * 60000); // 45 minutes duration

    const event = {
      summary: `PropEdge Tour: ${bookingData.property_name}`,
      description: `Property tour with ${bookingData.client_name}\nPhone: ${bookingData.client_phone || 'N/A'}\nEmail: ${bookingData.client_email || 'N/A'}${bookingData.notes ? '\nNotes: ' + bookingData.notes : ''}`,
      start: {
        dateTime: startDateTime.toISOString(),
        timeZone: process.env.TIMEZONE || 'Asia/Dubai', // Configurable timezone
      },
      end: {
        dateTime: endDateTime.toISOString(),
        timeZone: process.env.TIMEZONE || 'Asia/Dubai',
      },
      conferenceData: {
        createRequest: {
          requestId: `propedge-${Date.now()}`,
          conferenceSolutionKey: { type: 'hangoutsMeet' }
        }
      }
    };

    const response = await calendar.events.insert({
      calendarId: 'primary',
      resource: event,
      conferenceDataVersion: 1,
    });

    console.log("------------------------------------------");
    console.log("🎙️ REAL GOOGLE MEET CREATED");
    console.log("Meet Link:", response.data.hangoutLink);
    console.log("------------------------------------------");

    return {
      meeting_link: response.data.hangoutLink,
      meeting_id: response.data.id,
      type: 'google'
    };
  } catch (err) {
    console.error('🎙️ Google Service Error:', err.message);
    throw err;
  }
};

module.exports = { getGoogleAuthUrl, getGoogleTokens, createGoogleMeeting };
