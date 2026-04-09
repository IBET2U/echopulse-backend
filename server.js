require('dotenv').config();
const express = require('express');
const cors = require('cors');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { processEvent, getAllCustomers } = require('./scorer');
const { sendChurnAlert } = require('./mailer');
const app = express();

app.use('/webhook', express.raw({ type: 'application/json' }));
app.use(cors());
app.use(express.json());

app.get('/', (req, res) => {
  res.send('EchoPulse is alive');
});

app.get('/dashboard', (req, res) => {
  const customers = getAllCustomers();
  res.json({
    totalCustomers: customers.length,
    atRisk: customers.filter(c => c.riskLevel && c.riskLevel.label !== 'Green').length,
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

  const customerId = event.data.object.customer || 
                     event.data.object.id;
  const customerEmail = event.data.object.customer_email || 
                        event.data.object.email || 
                        null;

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
  sendChurnAlert(result, process.env.FOUNDER_EMAIL);
}
  }

  res.json({ received: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`EchoPulse scoring engine running on port ${PORT}`);
});