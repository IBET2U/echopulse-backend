const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.ALERT_EMAIL,
    pass: process.env.ALERT_EMAIL_PASSWORD,
  },
});

async function sendChurnAlert(customerData, founderEmail) {
  const { customerId, customerEmail, score, riskLevel, signals } = customerData;
  
  const signalList = signals
    .map(s => `• ${s.event} (weight: ${s.weight})`)
    .join('\n');

  const mailOptions = {
    from: process.env.ALERT_EMAIL,
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
  };

  try {
    await transporter.sendMail(mailOptions);
    console.log(`Alert email sent for customer ${customerId}`);
  } catch (error) {
    console.log('Email error:', error.message);
  }
}

module.exports = { sendChurnAlert };