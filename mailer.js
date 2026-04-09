const { Resend } = require('resend');
const resend = new Resend(process.env.RESEND_API_KEY);

async function sendChurnAlert(customerData, founderEmail) {
  const { customerId, customerEmail, score, riskLevel, signals } = customerData;
  
  const signalList = signals
    .map(s => `• ${s.event} (weight: ${s.weight})`)
    .join('\n');

  await resend.emails.send({
    from: 'EchoPulse <alerts@echopulse.co>',
    to: founderEmail,
    subject: `${riskLevel.emoji} EchoPulse Alert: Customer at ${riskLevel.label}`,
    text: `SHADOW CHURN ALERT\n\nCustomer ID: ${customerId}\nCustomer Email: ${customerEmail || 'Unknown'}\nRisk Level: ${riskLevel.label}\nScore: ${score}\n\nSignals Detected:\n${signalList}\n\n- EchoPulse\nechopulse.co`
  });
}

module.exports = { sendChurnAlert };