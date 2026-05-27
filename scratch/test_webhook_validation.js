// ─────────────────────────────────────────────────────────────────────────────
// scratch/test_webhook_validation.js — Integration Webhook Test Simulator
// ─────────────────────────────────────────────────────────────────────────────
// Simulates Vapi sending tool calls with raw, messy, and invalid parameters
// to ensure the backend validates and returns dynamic correction loops.
// ─────────────────────────────────────────────────────────────────────────────

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

console.log('🧪 Starting Vapi Webhook Integration Test Simulator...\n');

// Standard Vercel Server Port
const PORT = process.env.PORT || 5000;
const targetUrl = `http://localhost:${PORT}/api/vapi/webhook`;

// Load fetch dynamically
const runSimulator = async () => {
  const { default: fetch } = await import('node-fetch');

  // Test Case 1: Malformed Email Input (Should fail validation and return correction prompt)
  console.log('🔄 Test Case 1: Submitting malformed email...');
  const payload1 = {
    message: {
      type: 'function-call',
      functionCall: {
        id: 'call_mock_123',
        name: 'bookVisit',
        parameters: {
          visit_date: '2026-06-15',
          visit_time: '5 PM',
          property_interest: 'Palm Villa Estate',
          client_name: 'David Miller',
          client_email: 'david dot miller at gmail' // Malformed email (lacks .com)
        }
      },
      call: {
        id: 'call_vapi_123',
        customer: {
          number: '+14135559876',
          name: 'David Miller'
        },
        messages: [
          { role: 'assistant', message: 'Hi David! Which day works best for you?' },
          { role: 'user', message: 'I can make it on June 15th at 5 PM. Email is david dot miller at gmail.' }
        ]
      }
    }
  };

  try {
    const res1 = await fetch(targetUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload1)
    });

    const data1 = await res1.json();
    console.log('📥 Webhook Response 1:', JSON.stringify(data1, null, 2));

    const resultText = data1.results?.[0]?.result || '';
    if (resultText.includes('validation failed') || resultText.includes('issue with that email')) {
      console.log('✅ [PASS] Webhook correctly intercepted malformed email and returned correction guidance!\n');
    } else {
      console.error('❌ [FAIL] Webhook did not intercept malformed email or returned unexpected output.\n');
    }

    // Test Case 2: Clean Spoken Spelled-out Input (Should pass validation and successfully book)
    console.log('🔄 Test Case 2: Submitting valid spoken email and relative dates...');
    const tomorrowStr = new Date();
    tomorrowStr.setDate(tomorrowStr.getDate() + 1);
    const dateFormatted = tomorrowStr.toISOString().split('T')[0];

    const payload2 = {
      message: {
        type: 'function-call',
        functionCall: {
          id: 'call_mock_456',
          name: 'bookVisit',
          parameters: {
            visit_date: 'tomorrow', // Relative date
            visit_time: '11:00 AM',
            property_interest: 'Palm Villa Estate',
            client_name: 'David Miller',
            client_email: 'david dot miller ninety two at gmail dot com' // Spelled out email
          }
        },
        call: {
          id: 'call_vapi_456',
          customer: {
            number: '+14135559876',
            name: 'David Miller'
          },
          messages: [
            { role: 'assistant', message: 'Great! Let me get that booked. What is your email?' },
            { role: 'user', message: 'david dot miller ninety two at gmail dot com' }
          ]
        }
      }
    };

    const res2 = await fetch(targetUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload2)
    });

    const data2 = await res2.json();
    console.log('📥 Webhook Response 2:', JSON.stringify(data2, null, 2));

    const resultText2 = data2.results?.[0]?.result || '';
    if (resultText2.includes('successfully booked')) {
      console.log('✅ [PASS] Webhook successfully normalized spoken elements and completed showing booking!\n');
    } else {
      console.error('❌ [FAIL] Webhook showing booking failed unexpectedly.\n');
    }

  } catch (err) {
    console.error('❌ Simulator Connection Error:', err.message);
    console.log('💡 Note: Ensure your local server is running (e.g. PORT=5000 node api/index.js) before running this integration test.');
  }
};

runSimulator();
