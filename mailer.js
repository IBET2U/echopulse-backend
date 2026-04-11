require('dotenv').config();
const { Resend } = require('resend');

const resend = new Resend(process.env.RESEND_API_KEY);

async function sendChurnAlert(customer, assessment) {
  const riskEmoji = customer.risk_level === 'red' ? '🔴' : '🟡';
  
  try {
    await resend.emails.send({
      from: 'EchoPulse <onboarding@resend.dev>',
      to: process.env.FOUNDER_EMAIL,
      subject: `${riskEmoji} Shadow Churn Alert — ${customer.risk_level.toUpperCase()} Risk Customer Detected`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
          
          <div style="background: ${customer.risk_level === 'red' ? '#fee2e2' : '#fef9c3'}; border-left: 4px solid ${customer.risk_level === 'red' ? '#dc2626' : '#ca8a04'}; padding: 16px; border-radius: 8px; margin-bottom: 24px;">
            <h2 style="margin: 0; color: ${customer.risk_level === 'red' ? '#dc2626' : '#ca8a04'};">
              ${riskEmoji} Shadow Churn Detected
            </h2>
            <p style="margin: 8px 0 0 0; color: #374151;">
              A customer is showing signs of emotional disengagement before cancellation.
            </p>
          </div>

          <div style="background: #f9fafb; padding: 16px; border-radius: 8px; margin-bottom: 24px;">
            <h3 style="margin: 0 0 12px 0; color: #111827;">Customer Details</h3>
            <p style="margin: 4px 0;"><strong>Customer ID:</strong> ${customer.stripe_customer_id}</p>
            <p style="margin: 4px 0;"><strong>Email:</strong> ${customer.email || 'Unknown'}</p>
            <p style="margin: 4px 0;"><strong>Risk Level:</strong> ${customer.risk_level.toUpperCase()}</p>
            <p style="margin: 4px 0;"><strong>Risk Score:</strong> ${customer.risk_score}/100</p>
            <p style="margin: 4px 0;"><strong>Shadow Churn Stage:</strong> ${assessment.stage}</p>
            <p style="margin: 4px 0;"><strong>Signals Detected:</strong> ${customer.signals.join(', ')}</p>
          </div>

          <div style="background: #eff6ff; padding: 16px; border-radius: 8px; margin-bottom: 24px;">
            <h3 style="margin: 0 0 12px 0; color: #1d4ed8;">🧠 AI Assessment</h3>
            <p style="margin: 0; color: #1e3a5f; line-height: 1.6;">
              ${assessment.assessment}
            </p>
          </div>

          <div style="background: #f0fdf4; padding: 16px; border-radius: 8px; margin-bottom: 24px;">
            <h3 style="margin: 0 0 12px 0; color: #15803d;">✉️ Suggested Intervention Email</h3>
            <p style="margin: 0 0 8px 0;"><strong>Subject:</strong> ${assessment.email_subject}</p>
            <div style="background: white; padding: 16px; border-radius: 6px; border: 1px solid #bbf7d0;">
              <p style="margin: 0; white-space: pre-line; line-height: 1.6; color: #374151;">
                ${assessment.email_body}
              </p>
            </div>
          </div>

          <div style="background: #fafafa; padding: 16px; border-radius: 8px; border: 1px solid #e5e7eb;">
            <h3 style="margin: 0 0 12px 0; color: #374151;">⚡ Recommended Action</h3>
            <p style="margin: 0; color: #6b7280;">
              Copy the email above, personalize it with the customer's name, and send it within 
              the next 24 hours. Customers in the <strong>${assessment.stage}</strong> stage 
              have a 60-80% save rate when reached out to promptly.
            </p>
          </div>

          <div style="margin-top: 24px; padding-top: 16px; border-top: 1px solid #e5e7eb; text-align: center;">
            <p style="color: #9ca3af; font-size: 12px; margin: 0;">
              Powered by EchoPulse — Shadow Churn Detection for Stripe Founders
            </p>
            <p style="color: #9ca3af; font-size: 12px; margin: 4px 0 0 0;">
              echopulse.co
            </p>
          </div>

        </div>
      `
    });
    
    console.log('Shadow churn alert email sent successfully');
  } catch (err) {
    console.log('Email error:', err.message);
  }
}

module.exports = { sendChurnAlert };