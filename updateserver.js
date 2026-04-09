require('dotenv').config();
const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { processEvent, getAllCustomers } = require('./scorer');
const app = express();

app.use('/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());

app.get('/', (req, res) => {
  res.send('EchoPulse is alive');
});

// Dashboard endpoint - see all customer scores
app.get('/dashboard', (req, res) => {
  const customers = getAllCustomers();
  res.json({
    totalCustomers: customers.length,
    atRisk: customers.filter(c => c.riskLevel.label !== 'Green').length,
    customers: customers.sort((a, b) => b.score - a.score)
  });
});

app.post('/webhook', (req, res) => {
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

  // Extract customer info from event
  const customerId = event.data.object.customer || 
                     event.data.object.id;
  const customerEmail = event.data.object.customer_email || 
                        event.data.object.email || 
                        null;

  // Process through scoring engine
  const result = processEvent(event.type, customerId, customerEmail);

  if (result) {
    console.log(`\n${result.riskLevel.emoji} SHADOW CHURN SCORE UPDATE`);
    console.log(`Customer: ${result.customerEmail || result.customerId}`);
    console.log(`Event: ${event.type}`);
    console.log(`Score: ${result.score}`);
    console.log(`Risk Level: ${result.riskLevel.label}`);
    
    if (result.shouldAlert) {
      console.log(`\n🚨 ALERT NEEDED - ${result.riskLevel.label} STAGE`);
      console.log(`This customer needs attention NOW`);
    }
  }

  res.json({ received: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`EchoPulse scoring engine running on port ${PORT}`);
});