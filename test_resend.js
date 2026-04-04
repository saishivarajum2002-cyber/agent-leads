const { sendEmail } = require('./services/email');

async function testResend() {
  console.log("Testing Resend integration...");
  const result = await sendEmail({
    to: 'anitham1117@gmail.com', // Using a placeholder or the user's email if safe
    subject: 'PropEdge System Test',
    message: 'Resend integration is active and working!'
  });
  console.log("Result:", result);
}

testResend();
