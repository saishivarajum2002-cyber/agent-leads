// ─────────────────────────────────────────────────────────────────────────────
// scratch/test_extraction.js — Normalization & Validation Unit Tests
// ─────────────────────────────────────────────────────────────────────────────

const {
  normalizeSpokenEmail,
  normalizeSpokenPhone,
  normalizeSpokenTime,
  normalizeSpokenDate,
  validateBookingPayload
} = require('../services/extraction');

console.log('🧪 Starting Advanced Extraction & Normalization Unit Tests...\n');

let passCount = 0;
let failCount = 0;

function assertEqual(actual, expected, testName) {
  if (actual === expected) {
    console.log(`✅ [PASS] ${testName}`);
    passCount++;
  } else {
    console.error(`❌ [FAIL] ${testName}\n   Expected: "${expected}"\n   Actual:   "${actual}"`);
    failCount++;
  }
}

// 1. Email Normalization Tests
console.log('--- 📧 Spoken Email Normalization Tests ---');
assertEqual(
  normalizeSpokenEmail('john dot smith ninety two at gmail dot com'),
  'john.smith92@gmail.com',
  'Basic spoken email with spelled-out number'
);
assertEqual(
  normalizeSpokenEmail('sales underscore realty at yahoo dot co dot uk'),
  'sales_realty@yahoo.co.uk',
  'Email with underscore and multiple dots'
);
assertEqual(
  normalizeSpokenEmail('AGENT-sales23 at yahoo dot com'),
  'agent-sales23@yahoo.com',
  'Email with hyphen, mixed casing, and digits'
);
assertEqual(
  normalizeSpokenEmail('mike realty [at] outlook [dot] com'),
  'mikerealty@outlook.com',
  'Email with square brackets around delimiters'
);

// 2. Phone Normalization Tests
console.log('\n--- 📞 Spoken Phone Normalization Tests ---');
assertEqual(
  normalizeSpokenPhone('+1 (413) 555-1234'),
  '+14135551234',
  'Clean E.164 phone string'
);
assertEqual(
  normalizeSpokenPhone('plus one four one three five five five one two three four'),
  '+14135551234',
  'Phone spelled out in words'
);

// 3. Time Normalization Tests
console.log('\n--- ⏰ Spoken Time Normalization Tests ---');
assertEqual(
  normalizeSpokenTime('5 PM'),
  '17:00',
  'Convert PM time'
);
assertEqual(
  normalizeSpokenTime('around noon'),
  '12:00',
  'Convert noon to 12:00'
);
assertEqual(
  normalizeSpokenTime('in the evening'),
  '18:00',
  'Convert evening to 18:00'
);
assertEqual(
  normalizeSpokenTime('11:30 AM'),
  '11:30',
  'Convert AM time with minutes'
);

// 4. Date Normalization Tests
console.log('\n--- 📅 Spoken Date Normalization Tests ---');
const todayStr = new Date().toISOString().split('T')[0];
assertEqual(
  normalizeSpokenDate('today'),
  todayStr,
  'Parse relative "today"'
);

const tomorrow = new Date();
tomorrow.setDate(tomorrow.getDate() + 1);
const tomorrowStr = tomorrow.toISOString().split('T')[0];
assertEqual(
  normalizeSpokenDate('tomorrow'),
  tomorrowStr,
  'Parse relative "tomorrow"'
);

// 5. Validation Schema Tests
console.log('\n--- 🛡️ Schema Validation Tests ---');
const validPayload = {
  customer_name: 'John Smith',
  email: 'john.smith92@gmail.com',
  phone: '+14135551234',
  visit_date: tomorrowStr,
  visit_time: '17:00',
  property_address: 'Palm Villa Estate'
};
assertEqual(
  validateBookingPayload(validPayload).isValid,
  true,
  'Fully valid payload'
);

const invalidPayload = {
  customer_name: 'John Smith',
  email: 'invalid-email-address',
  phone: '123', // too short
  visit_date: '2020-01-01', // in the past
  visit_time: '5 PM', // malformed HH:MM
  property_address: '' // missing
};
const invalidResult = validateBookingPayload(invalidPayload);
assertEqual(
  invalidResult.isValid,
  false,
  'Detect malformed payload correctly'
);
console.log(`- Validation errors detected: \n  ${invalidResult.errors.join('\n  ')}`);

console.log(`\n======================================`);
console.log(`🧪 TEST SUMMARY: ${passCount} Passed, ${failCount} Failed.`);
console.log(`======================================`);

if (failCount > 0) {
  process.exit(1);
} else {
  process.exit(0);
}
