require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
});

async function generateChurnAssessment(customerData) {
  const message = await client.messages.create({
    model: 'claude-opus-4-5',
    max_tokens: 1024,
    messages: [
      {
        role: 'user',
        content: `You are EchoPulse, a shadow churn detection system. 
        
Analyze this at-risk customer and provide:
1. A brief assessment of why they are likely disengaging
2. Their shadow churn stage (Coasting, Fading, or Ghosting)
3. A personalized retention email the founder should send

Customer Data:
- Customer ID: ${customerData.stripe_customer_id}
- Risk Score: ${customerData.risk_score}/100
- - Risk Level: ${customerData.risk_level} (red = High Risk, yellow = At Risk, green = Healthy)
- Signals Detected: ${JSON.stringify(customerData.signals)}
- Days Since Last Activity: ${customerData.days_inactive || 'Unknown'}

Keep the email under 100 words, write it as a genuine founder checking in - curious, direct,  no corporate language, no "no pitch here" phrases. sound like a real person.
Format your response as JSON with keys: assessment, stage, email_subject, email_body`
      }
    ]
  });

  try {
    const content = message.content[0].text;
    const clean = content.replace(/```json|```/g, '').trim();
    return JSON.parse(clean);
  } catch(err) {
    console.log('Claude API error:', err.message);
  console.log('Full error:', JSON.stringify(err));
    return { 
      assessment: message.content[0].text,
      stage: 'Unknown',
      email_subject: 'Checking in',
      email_body: message.content[0].text
    };
  }
}

module.exports = { generateChurnAssessment };