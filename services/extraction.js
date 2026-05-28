// ─────────────────────────────────────────────────────────────────────────────
// services/extraction.js — Advanced Data Extraction, Normalization & Validation
// ─────────────────────────────────────────────────────────────────────────────
// Decodes messy conversational speech (e.g., spoken emails/times) and
// validates objects before database entry and workflow execution.
// ─────────────────────────────────────────────────────────────────────────────

const path = require('path');

// ── SPOKEN EMAIL NORMALIZATION ────────────────────────────────────────────────
function normalizeSpokenEmail(emailStr) {
  if (!emailStr) return '';
  
  let email = String(emailStr).toLowerCase().trim();

  // Replace spoken phrases
  email = email.replace(/\bat the rate of\b/g, '@');
  email = email.replace(/\b[\s\-_]*at[\s\-_]*\b/g, '@');
  email = email.replace(/\[at\]/g, '@');
  email = email.replace(/\bat\b/g, '@');

  email = email.replace(/\b[\s\-_]*dot[\s\-_]*\b/g, '.');
  email = email.replace(/\[dot\]/g, '.');
  email = email.replace(/\bpoint\b/g, '.');

  email = email.replace(/\b[\s]*underscore[\s]*\b/g, '_');
  email = email.replace(/\b[\s]*(hyphen|dash|minus)[\s]*\b/g, '-');

  // Spelling-to-digits simple mapping for emails (e.g., ninety two -> 92)
  const tens = {
    'twenty': 20, 'thirty': 30, 'forty': 40, 'fifty': 50,
    'sixty': 60, 'seventy': 70, 'eighty': 80, 'ninety': 90
  };
  const ones = {
    'one': 1, 'two': 2, 'three': 3, 'four': 4, 'five': 5,
    'six': 6, 'seven': 7, 'eight': 8, 'nine': 9
  };

  // Replace tens + ones combinations (e.g., ninety two / ninety-two -> 92)
  Object.keys(tens).forEach(tWord => {
    Object.keys(ones).forEach(oWord => {
      const val = tens[tWord] + ones[oWord];
      const regex = new RegExp(`\\b${tWord}[\\s\\-]*${oWord}\\b`, 'g');
      email = email.replace(regex, String(val));
    });
  });

  const numberMap = {
    'zero': '0', 'ten': '10', 'eleven': '11', 'twelve': '12', 'thirteen': '13',
    'fourteen': '14', 'fifteen': '15', 'sixteen': '16', 'seventeen': '17',
    'eighteen': '18', 'nineteen': '19',
    ...tens,
    ...ones
  };

  // Sort keys by length descending to prevent substring matching bugs (e.g., "fourteen" replacing "four")
  const sortedWords = Object.keys(numberMap).sort((a, b) => b.length - a.length);

  sortedWords.forEach(word => {
    const regex = new RegExp(`\\b${word}\\b`, 'g');
    email = email.replace(regex, String(numberMap[word]));
  });

  // Strip remaining spaces and all characters that aren't valid in emails
  email = email.replace(/[^a-z0-9@\.\-_\+]/g, '');

  // Handle double @ signs if any arose
  if ((email.match(/@/g) || []).length > 1) {
    const parts = email.split('@');
    email = parts[0] + '@' + parts.slice(1).join('');
  }

  return email;
}

// ── SPOKEN PHONE NORMALIZATION ────────────────────────────────────────────────
function normalizeSpokenPhone(phoneStr) {
  if (!phoneStr) return '';

  let cleaned = String(phoneStr).trim();

  // Replace spoken digits if they are spelled out
  const digitWords = {
    'zero': '0', 'one': '1', 'two': '2', 'three': '3', 'four': '4',
    'five': '5', 'six': '6', 'seven': '7', 'eight': '8', 'nine': '9'
  };
  Object.keys(digitWords).forEach(word => {
    const regex = new RegExp(`\\b${word}\\b`, 'gi');
    cleaned = cleaned.replace(regex, digitWords[word]);
  });

  // Check if it has a leading plus
  const hasPlus = cleaned.startsWith('+');

  // Remove non-digit characters
  cleaned = cleaned.replace(/\D/g, '');
  
  if (hasPlus) {
    cleaned = '+' + cleaned;
  } else {
    // Intelligent country code prepending
    if (cleaned.length === 10) {
      // 10-digit US number -> prepend +1
      cleaned = '+1' + cleaned;
    } else if (cleaned.length === 11 && cleaned.startsWith('1')) {
      // 11-digit US number starting with 1 -> prepend +
      cleaned = '+' + cleaned;
    } else if (cleaned.length > 0) {
      // Other numbers -> default to prepending +
      cleaned = '+' + cleaned;
    }
  }

  return cleaned;
}

// ── SPOKEN TIME NORMALIZATION (To 24-hour HH:MM Format) ───────────────────────
function normalizeSpokenTime(timeStr) {
  if (!timeStr) return '';

  let time = String(timeStr).toLowerCase().trim();

  // Colloquial replacements
  if (time.includes('noon')) return '12:00';
  if (time.includes('midnight')) return '00:00';
  if (time.includes('morning')) {
    if (time.includes('early')) return '08:00';
    return '09:00';
  }
  if (time.includes('afternoon')) return '14:00';
  if (time.includes('evening') || time.includes('night')) return '18:00';

  // Match something like "5 PM", "11:30 AM", "around 10 o'clock"
  const ampmMatch = time.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/);
  if (ampmMatch) {
    let hours = parseInt(ampmMatch[1]);
    let minutes = ampmMatch[2] ? parseInt(ampmMatch[2]) : 0;
    const ampm = ampmMatch[3];

    if (ampm === 'pm' && hours < 12) {
      hours += 12;
    } else if (ampm === 'am' && hours === 12) {
      hours = 0;
    }

    const hStr = String(hours).padStart(2, '0');
    const mStr = String(minutes).padStart(2, '0');
    return `${hStr}:${mStr}`;
  }

  // Fallback check if it's already HH:MM
  if (/^\d{2}:\d{2}$/.test(time)) return time;

  return timeStr;
}

// ── SPOKEN DATE NORMALIZATION (To YYYY-MM-DD Format) ─────────────────────────
function normalizeSpokenDate(dateStr) {
  if (!dateStr) return '';
  const lower = String(dateStr).toLowerCase().trim();
  
  // If it's already YYYY-MM-DD, return it
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return dateStr;
  
  const now = new Date();
  const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  
  if (lower === 'today') return now.toISOString().split('T')[0];
  if (lower === 'tomorrow') {
    const tomorrow = new Date(now);
    tomorrow.setDate(now.getDate() + 1);
    return tomorrow.toISOString().split('T')[0];
  }
  
  // Handle "next Thursday", "this Friday"
  const cleanDay = lower.replace(/next |this /g, '');
  const dayIndex = days.indexOf(cleanDay);
  if (dayIndex !== -1) {
    const todayIndex = now.getDay();
    let diff = dayIndex - todayIndex;
    if (diff <= 0) diff += 7; // standard forward-looking assumption
    
    const targetDate = new Date(now);
    targetDate.setDate(now.getDate() + diff);
    return targetDate.toISOString().split('T')[0];
  }

  // Fallback parser if we get something like "May 30th" or "30th May"
  try {
    const parsed = Date.parse(dateStr);
    if (!isNaN(parsed)) {
      const d = new Date(parsed);
      // Ensure we don't accidentally book in the past year
      if (d.getFullYear() < now.getFullYear()) {
        d.setFullYear(now.getFullYear());
      }
      return d.toISOString().split('T')[0];
    }
  } catch (e) {}
  
  return dateStr;
}

// ── VALIDATION SCHEMA ────────────────────────────────────────────────────────
function validateBookingPayload(payload) {
  const errors = [];
  const missingFields = [];

  const requiredFields = [
    { key: 'customer_name', label: 'Customer Name' },
    { key: 'email', label: 'Email Address' },
    { key: 'phone', label: 'Phone Number' },
    { key: 'visit_date', label: 'Visit Date' },
    { key: 'visit_time', label: 'Visit Time' },
    { key: 'property_address', label: 'Property Address' }
  ];

  // Check required
  requiredFields.forEach(f => {
    if (!payload[f.key] || String(payload[f.key]).trim() === '') {
      missingFields.push(f.key);
      errors.push(`Missing field: ${f.label}`);
    }
  });

  // Regex validators if fields are present
  if (payload.email) {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(payload.email)) {
      errors.push('Invalid email address format.');
    }
  }

  if (payload.phone) {
    // standard clean digits count check (minimum 8 characters)
    const digitsOnly = payload.phone.replace(/\D/g, '');
    if (digitsOnly.length < 8) {
      errors.push('Phone number is too short.');
    }
  }

  if (payload.visit_date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(payload.visit_date)) {
      errors.push('Visit Date is not in standard YYYY-MM-DD format.');
    } else {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const parsedDate = new Date(payload.visit_date);
      if (parsedDate < today) {
        errors.push('Visit Date cannot be in the past.');
      }
    }
  }

  if (payload.visit_time) {
    if (!/^\d{2}:\d{2}$/.test(payload.visit_time)) {
      errors.push('Visit Time is not in standard 24-hour HH:MM format.');
    }
  }

  return {
    isValid: errors.length === 0,
    errors,
    missingFields
  };
}

// ── GEMINI TRANSCRIPT STRUCTURED EXTRACTION ─────────────────────────────────────
async function extractDetailsFromTranscript(messages, fnArgs = {}) {
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      console.warn('⚠️ GEMINI_API_KEY missing - skipping LLM fallback extraction');
      return null;
    }

    const { GoogleGenerativeAI } = require('@google/generative-ai');
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

    // Format the messages array into a conversational text block
    let conversationText = '';
    if (Array.isArray(messages)) {
      conversationText = messages.map(m => {
        const role = m.role === 'assistant' ? 'Sarah' : 'Client';
        const text = m.message || m.content || '';
        return `${role}: ${text}`;
      }).join('\n');
    } else if (typeof messages === 'string') {
      conversationText = messages;
    }

    const currentYear = new Date().getFullYear();

    const prompt = `You are a high-performance data extraction agent.
Read this real estate call transcript between Sarah (our AI agent) and a client:

TRANSCRIPT:
"""
${conversationText}
"""

Also refer to the initial tool arguments passed by Vapi if they help clarify details:
${JSON.stringify(fnArgs)}

INSTRUCTION:
Extract the following 9 variables. Output ONLY a valid JSON block containing exactly these keys:
- "customer_name": Stated name of the client.
- "email": Stated email of the client (decode spoken phrases like "dot" or "at" naturally).
- "phone": The phone number of the client.
- "visit_date": Requested visit date in strict YYYY-MM-DD format (interpret relative terms relative to current year ${currentYear} and month).
- "visit_time": Requested visit time in strict 24-hour HH:MM format.
- "property_address": Stated interest property or listing name/address.
- "lead_type": Stated interest type, e.g. "buyer" or "renter".
- "budget": Stated budget amount.
- "preferred_area": Stated location preference.

If any field is missing or cannot be derived, set its value to an empty string "".
Do not output markdown code blocks like \`\`\`json. Output ONLY raw JSON text.`;

    const result = await model.generateContent(prompt);
    const response = await result.response;
    let text = response.text().trim();

    // Clean up markdown block styling if LLM added it anyway
    if (text.startsWith('```')) {
      text = text.replace(/^```json\s*/, '').replace(/```$/, '').trim();
    }

    const parsed = JSON.parse(text);
    return parsed;
  } catch (err) {
    console.error('❌ Fallback Extraction Error:', err.message);
    return null;
  }
}

module.exports = {
  normalizeSpokenEmail,
  normalizeSpokenPhone,
  normalizeSpokenTime,
  normalizeSpokenDate,
  validateBookingPayload,
  extractDetailsFromTranscript
};
