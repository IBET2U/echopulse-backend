const { Resend } = require('resend');

const resend = new Resend(process.env.RESEND_API_KEY);

const getRiskColor = (score) => {
  if (score >= 75) return '#ef4444';
  if (score >= 50) return '#f59e0b';
  return '#22c55e';
};

const getRiskLabel = (score) => {
  if (score >= 75) return 'HIGH RISK';
  if (score >= 50) return 'MEDIUM RISK';
  return 'LOW RISK';
};

const formatSignalDescription = (description) => {
  if (!description) return '<li>No signal details available</li>';
  return description
    .split(' | ')
    .map(article => `<li style="margin-bottom: 8px;">${article.trim()}</li>`)
    .join('');
};

const sendChurnAlert = async (customer, assessment) => {
  const companyName = customer.company_name || 
                      customer.stripe_customer_id || 
                      'Unknown Company';
  const riskScore = customer.risk_score || 70;
  const riskColor = getRiskColor(riskScore);
  const riskLabel = getRiskLabel(riskScore);
  const signalType = assessment.stage || 'WORLD_SIGNAL';
  const signalDescription = assessment.assessment || '';
  const recommendedAction = customer.recommended_action || 
                            'Review this account immediately and reach out today.';

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>EchoPulse World Signal Alert</title>
</head>
<body style="margin: 0; padding: 0; background-color: #0f172a; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;">
  
  <div style="max-width: 600px; margin: 0 auto; padding: 40px 20px;">
    
    <!-- Header -->
    <div style="text-align: center; margin-bottom: 32px;">
      <h1 style="color: #ffffff; font-size: 24px; font-weight: 700; margin: 0;">
        Echo<span style="color: #6366f1;">Pulse</span>
      </h1>
      <p style="color: #94a3b8; font-size: 13px; margin: 8px 0 0 0;">
        Every churn tool watches your product. We watch the world.
      </p>
    </div>

    <!-- Alert Banner -->
    <div style="background-color: #1e293b; border: 1px solid ${riskColor}; border-radius: 12px; padding: 24px; margin-bottom: 24px;">
      <div style="display: flex; align-items: center; margin-bottom: 16px;">
        <span style="font-size: 20px; margin-right: 8px;">⚠️</span>
        <h2 style="color: #ffffff; font-size: 18px; font-weight: 700; margin: 0;">
          World Signal Detected
        </h2>
      </div>
      <p style="color: #94a3b8; font-size: 14px; margin: 0; line-height: 1.6;">
        EchoPulse detected a real world signal around one of your B2B customers. 
        This signal indicates potential churn risk that requires your attention.
      </p>
    </div>

    <!-- Customer Details -->
    <div style="background-color: #1e293b; border-radius: 12px; padding: 24px; margin-bottom: 24px;">
      <h3 style="color: #6366f1; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 1px; margin: 0 0 16px 0;">
        Customer At Risk
      </h3>
      
      <table style="width: 100%; border-collapse: collapse;">
        <tr>
          <td style="color: #94a3b8; font-size: 14px; padding: 8px 0; width: 40%;">Company</td>
          <td style="color: #ffffff; font-size: 14px; font-weight: 600; padding: 8px 0;">${companyName}</td>
        </tr>
        <tr>
          <td style="color: #94a3b8; font-size: 14px; padding: 8px 0;">Customer ID</td>
          <td style="color: #ffffff; font-size: 14px; padding: 8px 0;">${customer.stripe_customer_id}</td>
        </tr>
        <tr>
          <td style="color: #94a3b8; font-size: 14px; padding: 8px 0;">Signal Type</td>
          <td style="color: #ffffff; font-size: 14px; padding: 8px 0;">${signalType}</td>
        </tr>
        <tr>
          <td style="color: #94a3b8; font-size: 14px; padding: 8px 0;">Risk Score</td>
          <td style="padding: 8px 0;">
            <span style="background-color: ${riskColor}; color: #ffffff; font-size: 12px; font-weight: 700; padding: 4px 10px; border-radius: 20px;">
              ${riskScore}/100 — ${riskLabel}
            </span>
          </td>
        </tr>
      </table>
    </div>

    <!-- Signal Details -->
    <div style="background-color: #1e293b; border-radius: 12px; padding: 24px; margin-bottom: 24px;">
      <h3 style="color: #6366f1; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 1px; margin: 0 0 16px 0;">
        World Signals Detected
      </h3>
      <ul style="color: #e2e8f0; font-size: 14px; line-height: 1.8; margin: 0; padding-left: 20px;">
        ${formatSignalDescription(signalDescription)}
      </ul>
    </div>

    <!-- Recommended Action -->
    <div style="background-color: #312e81; border-radius: 12px; padding: 24px; margin-bottom: 24px;">
      <h3 style="color: #a5b4fc; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 1px; margin: 0 0 12px 0;">
        Recommended Action
      </h3>
      <p style="color: #ffffff; font-size: 15px; font-weight: 600; margin: 0; line-height: 1.6;">
        ${recommendedAction}
      </p>
      <p style="color: #a5b4fc; font-size: 13px; margin: 12px 0 0 0;">
        Customers contacted within 48 hours of a world signal have a 
        <strong style="color: #ffffff;">60-80% save rate.</strong>
      </p>
    </div>

    <!-- CTA Button -->
    <div style="text-align: center; margin-bottom: 32px;">
      <a href="https://echopulse.co/dashboard.html" 
         style="background-color: #6366f1; color: #ffffff; font-size: 15px; font-weight: 600; padding: 14px 32px; border-radius: 8px; text-decoration: none; display: inline-block;">
        View Full Dashboard →
      </a>
    </div>

    <!-- Footer -->
    <div style="text-align: center; border-top: 1px solid #1e293b; padding-top: 24px;">
      <p style="color: #475569; font-size: 12px; margin: 0 0 8px 0;">
        Monitored by <strong style="color: #6366f1;">EchoPulse</strong>
      </p>
      <p style="color: #475569; font-size: 12px; margin: 0;">
        <a href="https://echopulse.co" style="color: #6366f1; text-decoration: none;">echopulse.co</a>
      </p>
    </div>

  </div>
</body>
</html>
  `;

  try {
    await resend.emails.send({
      from: 'EchoPulse <onboarding@resend.dev>',
      to: process.env.FOUNDER_EMAIL,
      subject: `⚠️ World Signal Alert — ${companyName} is at risk`,
      html
    });
    console.log('EchoPulse world signal alert sent successfully');
  } catch (err) {
    console.error('Alert email error:', err.message);
  }
};

module.exports = { sendChurnAlert };