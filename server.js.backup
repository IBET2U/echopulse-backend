require('dotenv').config();
const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');
const { generateChurnAssessment } = require('./claude');
const { sendChurnAlert } = require('./mailer');
const cors = require('cors');
const app = express();
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

app.use('/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());
app.use(cors());
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
    // Validate key by calling Stripe
    const Stripe = require('stripe');
    const stripeClient = Stripe(stripe_key);
    
    // Pull their customers immediately
    const customers = await stripeClient.customers.list({ limit: 100 });
    const account_id = `acct_${Date.now()}`;

    // Register webhook on their account
    const webhook = await stripeClient.webhookEndpoints.create({
      url: 'https://echopulse-backend.onrender.com/webhook',
      enabled_events: [
        'customer.subscription.deleted',
        'customer.subscription.updated', 
        'customer.updated',
        'invoice.payment_failed',
        'payment_method.detached',
        'customer.discount.created'
      ],
    });

    // Store account in Supabase
    await supabase.from('accounts').upsert({
      account_id: account_id,
      stripe_key: stripe_key,
      webhook_secret: webhook.secret,
      founder_name: founder_name || 'Founder',
      founder_email: founder_email,
      connected_at: new Date().toISOString()
    });

    // Immediately score their existing customers
    for (const customer of customers.data) {
      await supabase.from('customers').upsert({
        stripe_customer_id: customer.id,
        account_id: account_id,
        email: customer.email || 'Unknown',
        risk_level: 'green',
        risk_score: 0,
        signals: [],
        created_at: new Date().toISOString()
      });
    }

    console.log(`New account connected: ${founder_email} with ${customers.data.length} customers`);

    res.json({ 
      success: true,
      account_id: account_id,
      customers_imported: customers.data.length,
      message: `Connected. Monitoring ${customers.data.length} customers.`
    });

  } catch(err) {
    console.error('Connect error:', err.message);
    res.status(400).json({ 
      error: err.message || 'Connection failed. Check your API key.'
    });
  }
  app.get('/dashboard', async (req, res) => {
  try {
    const { createClient } = require('@supabase/supabase-js');
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_ANON_KEY
    );

    const { data: customers, error } = await supabase
      .from('customers')
      .select('*')
      .order('risk_score', { ascending: false });

    if (error) throw error;

    const redCount = customers.filter(c => c.risk_level === 'Red').length;

    res.json({
      totalCustomers: customers.length,
      customers: customers.map(c => ({
        customerId: c.stripe_customer_id || c.id,
        customerEmail: c.email || 'Unknown',
        score: c.score || c.risk_score || 0,
        riskLevel: { label: c.risk_level || 'Green' },
        signals: c.signals || []
      }))
    });

  } catch (err) {
    console.error('/dashboard error:', err);
    res.status(500).json({ error: err.message });
  }
});
});
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`EchoPulse server running on port ${PORT}`);
});