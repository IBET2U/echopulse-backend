const { Resend } = require('resend');

const resend = new Resend(process.env.RESEND_API_KEY);

async function sendChurnAlert(customerData, founderEmail) {
  const { customerId, customerEmail, score, riskLevel, signals } = customerData;
  
  const signalList = signals
    .map(s => `• ${s.event} (weight: ${s.weight})`)
    .join('\n');

  try {
    await resend.emails.send({
      from: 'EchoPulse <onboarding@resend.dev>',
      to: founderEmail,
      subject: `${riskLevel.emoji} EchoPulse Alert: Customer at ${riskLevel.label} Stage`,
      text: `
SHADOW CHURN ALERT
------------------
Customer ID: ${customerId}
Customer Email: ${customerEmail || 'Unknown'}
Risk Level: ${riskLevel.label}
Score: ${score}

Signals Detected:
${signalList}

This customer needs your attention NOW.
Log in to your dashboard to take action.

--
EchoPulse Shadow Churn Detection
echopulse.co
      `,
    });
    console.log(`Alert email sent for customer ${customerId}`);
  } catch (error) {
    console.log('Email error:', error.message);
  }
}

module.exports = { sendChurnAlert };