require('dotenv').config();
const path = require('path');
const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');
const { generateChurnAssessment } = require('./claude');
const { sendChurnAlert } = require('./mailer');
const Anthropic = require('@anthropic-ai/sdk');
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const cors = require('cors');
const { apiLimiter } = require('./middleware/rateLimiter');
const { startScheduler } = require('./intelligence/scheduler');
const intelligenceRoutes = require('./routes/intelligence');
const app = express();
app.set('trust proxy', 1);
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

app.use('/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());
app.use(cors());
app.use('/api/', apiLimiter);
app.use('/api/intelligence', intelligenceRoutes);
app.get('/', (req, res) => {
  res.send('EchoPulse is alive');
});app.post('/waitlist', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });

  try {
    const { Resend } = require('resend');
    const resend = new Resend(process.env.RESEND_API_KEY);
    
    await resend.emails.send({
      from: 'EchoPulse <onboarding@resend.dev>',
      to: process.env.FOUNDER_EMAIL,
      subject: '🎯 New EchoPulse Waitlist Signup',
      html: `<p>New waitlist signup: <strong>${email}</strong></p><p>Time: ${new Date().toLocaleString()}</p>`
    });

    res.json({ success: true });
  } catch(err) {
    console.log('Waitlist error:', err.message);
    res.json({ success: true });
  }
});
app.post('/assessment', async (req, res) => {
  const { customer_id } = req.body;
  
  try {
    let { data: customer } = await supabase
      .from('customers')
      .select('*')
      .eq('stripe_customer_id', customer_id)
      .single();

    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    const assessment = await generateChurnAssessment({
      stripe_customer_id: customer_id,
      risk_score: customer.risk_score,
      risk_level: customer.risk_level,
      signals: customer.signals,
      days_inactive: 0
    });

    res.json(assessment);
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});
app.post('/webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.log('Webhook error:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Shadow churn signals we care about
  const shadowChurnEvents = [
    'customer.subscription.deleted',
    'customer.subscription.updated',
    'invoice.payment_failed',
    'customer.updated',
    'payment_method.detached'
  ];

  if (shadowChurnEvents.includes(event.type)) {
    console.log(`Shadow churn signal detected: ${event.type}`);
    
    const customerId = event.data.object.customer || 
                       event.data.object.id;

    if (customerId) {
      await processChurnSignal(customerId, event.type);
    }
  }

  res.json({ received: true });
});

async function processChurnSignal(customerId, eventType) {
  try {
    // Get or create customer in Supabase
    let { data: customer } = await supabase
      .from('customers')
      .select('*')
      .eq('stripe_customer_id', customerId)
      .single();

    if (!customer) {
      const { data: newCustomer } = await supabase
        .from('customers')
        .insert({
          stripe_customer_id: customerId,
          signals: [eventType],
          risk_score: 25,
          risk_level: 'yellow'
        })
        .select()
        .single();
      customer = newCustomer;
    } else {
      // Add new signal and recalculate score
      const signals = [...(customer.signals || []), eventType];
      const riskScore = Math.min(signals.length * 25, 100);
      const riskLevel = riskScore >= 75 ? 'red' : 
                        riskScore >= 50 ? 'yellow' : 'green';

      const { data: updated } = await supabase
        .from('customers')
        .update({
          signals,
          risk_score: riskScore,
          risk_level: riskLevel,
          last_signal_at: new Date()
        })
        .eq('stripe_customer_id', customerId)
        .select()
        .single();
      customer = updated;
    }

    console.log(`Customer ${customerId} risk level: ${customer.risk_level}`);

    // Only call Claude for yellow or red customers
    if (customer.risk_level === 'yellow' || 
        customer.risk_level === 'red') {
      console.log('Generating AI assessment...');
      
      const assessment = await generateChurnAssessment({
        stripe_customer_id: customerId,
        risk_score: customer.risk_score,
        risk_level: customer.risk_level,
        signals: customer.signals,
        days_inactive: 0
      });

      console.log('\n=== ECHOPULSE SHADOW CHURN ALERT ===');
      console.log(`Customer: ${customerId}`);
      console.log(`Risk Level: ${customer.risk_level.toUpperCase()}`);
      console.log(`Stage: ${assessment.stage}`);
      console.log(`Assessment: ${assessment.assessment}`);
      console.log(`\nSuggested Email Subject: ${assessment.email_subject}`);
      console.log(`\nSuggested Email:\n${assessment.email_body}`);
      console.log('=====================================\n');
    await sendChurnAlert(customer, assessment);
    }


  } catch (err) {
    console.log('Error processing churn signal:', err.message);
  }
}
// Connect endpoint - founders paste their Stripe restricted key
app.post('/connect', async (req, res) => {
  const { stripe_key, founder_name, founder_email } = req.body;
  if (!stripe_key || !stripe_key.startsWith('rk_')) {
    return res.status(400).json({ 
      error: 'Invalid key. Must be a restricted key starting with rk_' 
    });
  }
  try {
    const Stripe = require('stripe');
    const stripeClient = Stripe(stripe_key);
    const customers = await stripeClient.customers.list({ limit: 100 });
    const account_id = `acct_${Date.now()}`;
    await supabase.from('accounts').upsert({
      account_id, stripe_key,
      webhook_secret: '',
      founder_name: founder_name || 'Founder',
      founder_email,
      connected_at: new Date().toISOString()
    });
    const defaultUserId = '00000000-0000-0000-0000-000000000000';
    for (const customer of customers.data) {
      await supabase.from('customers').upsert({
        stripe_customer_id: customer.id,
        account_id,
        email: customer.email || 'Unknown',
        risk_level: 'green',
        risk_score: 0,
        signals: [],
        created_at: new Date().toISOString()
      });

      const emailDomain = (customer.email || '').split('@')[1] || null;
      const company_name = customer.name || emailDomain || 'Unknown';

      const { data: existingCompany, error: existsError } = await supabase
        .from('monitored_contacts')
        .select('id')
        .eq('company_name', company_name)
        .maybeSingle();

      if (existsError) {
        console.error('monitored_contacts lookup error:', existsError.message);
        continue;
      }

      if (!existingCompany) {
        const { error: insertContactError } = await supabase
          .from('monitored_contacts')
          .insert({
            stripe_customer_id: customer.id,
            company_name,
            user_id: defaultUserId,
            linkedin_url: null,
            contact_name: null
          });

        if (insertContactError) {
          console.error('monitored_contacts insert error:', insertContactError.message);
        }
      }
    }
    res.json({ 
      success: true,
      account_id,
      customers_imported: customers.data.length,
      message: `Connected. Monitoring ${customers.data.length} customers.`
    });
  } catch(err) {
    console.error('Connect error:', err.message);
    res.status(400).json({ 
      error: err.message || 'Connection failed. Check your API key.'
    });
  }
});

app.get('/dashboard', async (req, res) => {
  try {
    const { createClient } = require('@supabase/supabase-js');
    const serviceSupabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY
    );
    const accountId = req.query.account_id;
    let query = serviceSupabase
      .from('customers')
      .select('*')
      .order('risk_score', { ascending: false });

    if (accountId) {
      query = query.eq('account_id', accountId);
    }

    const { data: customers, error } = await query;
    if (error) throw error;
    res.json({
      totalCustomers: customers.length,
      customers: customers.map(c => ({
        customerId: c.stripe_customer_id || c.id,
        customerEmail: c.email || 'Unknown',
        score: c.risk_score || 0,
        riskLevel: { label: c.risk_level || 'green' },
        signals: c.signals || []
      }))
    });
  } catch (err) {
    console.error('/dashboard error:', err.message);
    res.status(500).json({ error: err.message });
  }
});
app.post('/assess', async (req, res) => {
  try {
    const { stripe_customer_id, risk_level, risk_score } = req.body;
    const { data: customers } = await supabase
      .from('customers').select('*')
      .eq('stripe_customer_id', stripe_customer_id).limit(1);
    const customer = customers?.[0] || { 
      stripe_customer_id, risk_level, risk_score, signals: [] 
    };
    const assessment = await generateChurnAssessment(customer);
    res.json(assessment);
  } catch(err) {
    console.error('/assess error:', err.message);
    res.status(500).json({ error: err.message });
  }
});
app.post('/assess', async (req, res) => {
  try {
    const { stripe_customer_id, risk_level, risk_score } = req.body;
    const { data: customers } = await supabase
      .from('customers').select('*')
      .eq('stripe_customer_id', stripe_customer_id).limit(1);
    const customer = customers?.[0] || { stripe_customer_id, risk_level, risk_score, signals: [] };
    const assessment = await generateChurnAssessment(customer);
    res.json(assessment);
  } catch(err) {
    console.error('/assess error:', err.message);
    res.status(500).json({ error: err.message });
  }
});
app.post('/echoassist', async (req, res) => {
  try {
    const { transcript, language } = req.body;
    if (!transcript) return res.status(400).json({ error: 'No transcript provided' });

    const message = await anthropic.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 512,
      messages: [{
        role: 'user',
        content: `You are EchoAssist, a real-time AI coach for customer service and insurance reps on live calls.

A customer just said:
"${transcript}"

${language && language !== 'en' ? `The customer appears to be speaking ${language}. Translate what they said to English first.` : ''}

Respond ONLY with valid JSON — no markdown, no explanation:
{
  "translation": "English translation if not English, otherwise null",
  "sentiment": "positive or neutral or frustrated or angry",
  "churn_risk": "high or medium or low",
  "churn_reason": "one sentence explaining the churn risk level",
  "retention_action": "exactly what the rep should do right now to keep the customer",
  "suggested_response": "What the rep should say next, under 50 words, warm and direct",
  "suggested_response_spanish": "Same response in Spanish",
  "alert": "CANCEL THREAT or PAYMENT ISSUE or ESCALATION NEEDED or null",
  "coaching_tip": "One quick tip for the rep, under 15 words"
}`
      }]
    });

    const text = message.content[0].text;
    const clean = text.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);
    res.json({ success: true, ...parsed });

  } catch (err) {
    console.error('/echoassist error:', err.message);
    res.status(500).json({ error: err.message });
  }
});
app.post('/echoassist-summary', async (req, res) => {
  try {
    const { transcript } = req.body;
    if (!transcript) return res.status(400).json({ error: 'No transcript provided' });

    const message = await anthropic.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: `You are EchoAssist. A customer service call just ended. Here is the full transcript:

"${transcript}"

Generate a structured call summary. Respond ONLY with valid JSON — no markdown, no explanation:
{
  "reason_for_call": "One sentence describing why the customer called",
  "customer_sentiment": "positive or neutral or frustrated or angry",
  "churn_risk": "high or medium or low",
  "key_points": ["point 1", "point 2", "point 3"],
  "outcome": "One sentence describing what was resolved or decided",
  "next_steps": ["step 1", "step 2"],
  "compliance_flags": ["flag 1"] or [],
  "rep_performance_score": 85,
  "rep_performance_note": "One sentence coaching note for the rep"
}`
      }]
    });

    const text = message.content[0].text;
    const clean = text.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);
    res.json({ success: true, ...parsed });

  } catch (err) {
    console.error('/echoassist-summary error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
startScheduler();
app.listen(PORT, () => {
  console.log(`EchoPulse server running on port ${PORT}`);
});