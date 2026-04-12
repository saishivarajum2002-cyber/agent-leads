const { sendEmail } = require('./services/email');

async function testFlow() {
  console.log("🚀 STARTING AUTOMATED EMAIL FLOW TEST...");
  
  // Test 1: Verify direct delivery (Mocking a client email)
  console.log("\n--- TEST 1: Direct Delivery Verification ---");
  const t1 = await sendEmail({
    to: 'anitham1117@gmail.com',
    subject: 'Direct Test ' + Date.now(),
    message: 'If you see this WITHOUT a [For:] prefix, the fix is 100% working.'
  });
  
  if (t1.success) {
    console.log("✅ Test 1 Success: Email accepted for delivery.");
  } else {
    console.error("❌ Test 1 Failed:", t1.error);
  }

  // Test 2: Check Environment Override Status
  console.log("\n--- TEST 2: Environment Audit ---");
  if (process.env.RESEND_TO_OVERRIDE) {
    console.log(`ℹ️ RESEND_TO_OVERRIDE is detected in environment: ${process.env.RESEND_TO_OVERRIDE}`);
    console.log("ℹ️ Our code is now explicitly ignoring this to force real delivery.");
  } else {
    console.log("✅ RESEND_TO_OVERRIDE is not present in local environment.");
  }

  console.log("\n🚀 TEST COMPLETE. PLEASE CHECK INBOX FOR CLEAN SUBJECTS.");
}

testFlow();
