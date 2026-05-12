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

const SUPERVISOR_KEY = 'echopulse-supervisor-2026';
const validSupervisorKey = (k) => k === SUPERVISOR_KEY;

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
  const { createClient } = require('@supabase/supabase-js');
  const serviceSupabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );
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
    await serviceSupabase.from('accounts').upsert({
      account_id, stripe_key,
      webhook_secret: '',
      founder_name: founder_name || 'Founder',
      founder_email,
      connected_at: new Date().toISOString()
    });
    const defaultUserId = '00000000-0000-0000-0000-000000000000';
    for (const customer of customers.data) {
      await serviceSupabase.from('customers').upsert({
        stripe_customer_id: customer.id,
        account_id,
        email: customer.email || 'Unknown',
        risk_level: 'green',
        risk_score: 0,
        signals: [],
        created_at: new Date().toISOString()
      });

      const emailDomain = (customer.email || '').split('@')[1] || null;

      // Skip personal email domains
      const personalDomains = ['gmail.com', 'yahoo.com', 'hotmail.com', 
        'outlook.com', 'icloud.com', 'me.com', 'aol.com'];

      const isPersonalEmail = personalDomains.includes(emailDomain);

      // Use company name from Stripe, or domain if business email, 
      // or customer ID if nothing else
      const company_name = customer.name || 
        (!isPersonalEmail && emailDomain ? emailDomain : null) || 
        `Customer ${customer.id}`;

      // Skip monitoring personal email customers - no useful signals
      if (isPersonalEmail && !customer.name) {
        console.log(`Skipping personal email customer: ${customer.email}`);
        continue;
      }

      const business_description = `Company: ${company_name}. Email domain: ${emailDomain || ''}. Stripe customer since: ${customer.created ? new Date(customer.created * 1000).toISOString().split('T')[0] : 'unknown'}.`;

      const { data: existingCompany, error: existsError } = await serviceSupabase
        .from('monitored_contacts')
        .select('id')
        .eq('company_name', company_name)
        .maybeSingle();

      if (existsError) {
        console.error('monitored_contacts lookup error:', existsError.message);
        continue;
      }

      if (!existingCompany) {
        const { error: insertContactError } = await serviceSupabase
          .from('monitored_contacts')
          .insert({
            stripe_customer_id: customer.id,
            company_name,
            user_id: defaultUserId,
            linkedin_url: null,
            contact_name: null,
            industry: null,
            business_description: business_description,
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
        content: `You are an elite customer service AI coach with 15 years of experience training CSR teams at top BPO call centers. You think like a senior QA manager who understands real call dynamics, not just scripts.

TRANSCRIPT FORMAT:
- AGENT: lines = the rep speaking
- CALLER: lines = the customer speaking
- Analyze each separately. Never confuse them.

CHURN RISK INTELLIGENCE — think carefully before assigning risk:
- 'high' churn risk = caller is emotionally frustrated, has an unresolved billing issue, feels ignored, or has threatened to leave multiple times
- 'medium' churn risk = caller is mildly dissatisfied but open to solutions
- 'low' churn risk = caller has a simple fixable issue, is calm, or is canceling for reasons completely outside the company's control
- CRITICAL: If a caller is canceling because they are moving out of the country, relocating, deceased account holder, military deployment, or any reason beyond the company's control — this is LOW churn risk, not high. Do not flag these as retention opportunities. Instead suggest a graceful professional closing.
- CRITICAL: If a caller is canceling because of a competitor, price, or service issue — this IS high churn risk and needs retention action.

CHURN REASON — be specific. Never leave this blank if churn_risk is medium or high. Examples: 'moving abroad', 'found cheaper competitor', 'unhappy with service speed', 'billing dispute unresolved', 'never used the service'.

RETENTION ACTION — only suggest retention actions that are actually possible:
- If canceling due to relocation abroad: 'Acknowledge situation, offer account pause or transfer if available, close gracefully'
- If canceling due to price: 'Offer loyalty discount, escalate to retention team, present current promotions'
- If canceling due to service issue: 'Acknowledge the specific issue, escalate if needed, offer service credit'
- NEVER suggest finding coverage in another country if no such product exists
- NEVER suggest impossible retention actions

SUGGESTED RESPONSE RULES — this is the most important field:
- Read the scorecardState object carefully. NEVER ask for anything already marked true.
- Read the LAST CALLER: line. Respond directly and specifically to what they just said.
- If the caller gave a reason for calling, acknowledge that reason by name before doing anything else
- Sound like a real experienced human CSR, not a robot reading a script
- Keep responses under 2 sentences when possible
- Never start with 'Certainly!' or 'Absolutely!' — these sound fake
- If verification is incomplete, ask for ONE thing at a time in this order: full name → date of birth → SSN (last 4 only) → address → phone → email
- If all verification is done, focus 100% on solving the caller's actual problem
- If the caller is emotional or upset, lead with empathy before any verification

QA SCORECARD RULES — be generous but accurate:
- greeting_completed: true if AGENT said any form of hello, thank you for calling, or welcome
- caller_full_name_verified: true if CALLER stated their name OR AGENT asked and CALLER confirmed
- date_of_birth_verified: true if CALLER said any date that sounds like a birthdate
- ssn_verified: true if CALLER provided any digits described as SSN or social security
- address_verified: true if CALLER mentioned any street, city, zip, or address
- phone_number_verified: true if CALLER provided any phone number OR AGENT confirmed the number on file
- email_verified: true if CALLER provided any email address
- required_script_disclosure_read: true if AGENT read any policy, terms, disclosure, or legal statement
- closing_script_completed: true if AGENT said any form of goodbye, thank you for calling, have a good day

REP SCORE — always return a number 0-100. Never return null or skip this field:
- Start at 100 and deduct points:
- Deduct 15 if agent asked for information already provided by the caller
- Deduct 10 if agent ignored the caller's stated reason for calling
- Deduct 10 if agent gave an impossible or irrelevant suggestion
- Deduct 10 if agent skipped verification steps
- Deduct 5 for each missed QA scorecard item that should have been completed by this point in the call
- Add 10 if agent showed empathy when caller was upset
- Add 10 if agent offered a specific relevant solution
- Minimum score is 0, maximum is 100

COACHING TIP — be specific and actionable. Reference exactly what happened in the transcript. Never give generic advice like 'be professional'. Example: 'The caller mentioned moving abroad — this is not a retention situation. Acknowledge their move, wish them well, and offer a clean account closure.'

ALERT — only fire an alert if something genuinely urgent is happening: caller is threatening to escalate, caller is extremely angry, caller mentioned legal action, or caller has been on hold too long. Do not alert for normal cancellation requests.

SENTIMENT — choose from: positive, neutral, frustrated, angry, sad, confused

Return ONLY a valid JSON object with these exact fields:
{
  alert: string or null,
  translation: string or null,
  churn_risk: 'low' | 'medium' | 'high',
  churn_reason: string,
  retention_action: string,
  sentiment: string,
  suggested_response: string,
  suggested_response_spanish: string,
  coaching_tip: string,
  rep_score: number,
  qa_scorecard: {
    greeting_completed: boolean,
    caller_full_name_verified: boolean,
    date_of_birth_verified: boolean,
    ssn_verified: boolean,
    address_verified: boolean,
    phone_number_verified: boolean,
    email_verified: boolean,
    required_script_disclosure_read: boolean,
    closing_script_completed: boolean
  }
}

Transcript and context (may include AGENT:/CALLER: lines and scorecardState as JSON):
"${transcript}"

${language && language !== 'en' ? `The customer appears to be speaking ${language}. Translate what they said to English first.` : ''}`
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


app.post('/echoassist-supervisor-alert', async (req, res) => {
  try {
    const { repId, agentLoadLevel, sessionCallCount, timestamp } = req.body || {};
    const rid = String(repId || 'unknown');
    const ts = timestamp ? new Date(timestamp).toISOString() : new Date().toISOString();

    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      console.warn('[echoassist-supervisor-alert] Supabase env missing; skipping DB insert');
      return res.json({ success: true, skipped: 'supabase' });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const row = {
      rep_id: rid,
      agent_load_level: String(agentLoadLevel || ''),
      session_call_count: Number(sessionCallCount) || 0,
      timestamp: ts,
      created_at: new Date().toISOString()
    };

    const { error: insertErr } = await supabase.from('supervisor_alerts').insert(row);
    if (insertErr) {
      console.error('[supervisor_alerts]', insertErr);
      return res.status(500).json({ success: false, error: insertErr.message });
    }

    let supervisorEmail = process.env.SUPERVISOR_FALLBACK_EMAIL || null;
    const { data: userRow, error: userErr } = await supabase
      .from('echoassist_users')
      .select('supervisor_email')
      .eq('rep_id', rid)
      .maybeSingle();
    if (userErr) console.warn('[echoassist_users]', userErr.message);
    if (userRow?.supervisor_email) supervisorEmail = userRow.supervisor_email;

    if (RESEND_API_KEY && RESEND_FROM && supervisorEmail) {
      const resend = new Resend(RESEND_API_KEY);
      await resend.emails.send({
        from: RESEND_FROM,
        to: supervisorEmail,
        subject: `[EchoAssist] Coaching check-in flag — ${rid}`,
        html: `<p>Rep <strong>${escapeHtml(rid)}</strong> requested a quiet check-in.</p>
<p>Agent load: ${escapeHtml(String(agentLoadLevel))}<br/>
Session call count: ${escapeHtml(String(sessionCallCount))}<br/>
Timestamp: ${escapeHtml(ts)}</p>`
      });
    } else {
      console.warn('[echoassist-supervisor-alert] Resend or supervisor email not configured');
    }

    return res.json({ success: true });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ success: false, error: e.message || 'supervisor-alert failed' });
  }
});

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function parseHighLoadTimestamps(raw) {
  if (Array.isArray(raw)) return raw.map((x) => (typeof x === 'string' ? x : String(x)));
  if (typeof raw === 'string') {
    try {
      const j = JSON.parse(raw);
      return Array.isArray(j) ? j.map(String) : [];
    } catch {
      return [];
    }
  }
  return [];
}

function minuteBucketUtc(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}-${d.getUTCHours()}-${d.getUTCMinutes()}`;
}

/**
 * POST /echoassist-heartbeat
 * Body: { agentId, agentName, status, agentLoadLevel, qaScore, callStreak, isOnCall, echoShieldActive, callStartedAt? }
 * Upserts echoassist_users (requires extended columns — see supervisor.html SQL comments).
 */
app.post('/echoassist-heartbeat', async (req, res) => {
  try {
    
    if (!supabase) {
      return res.json({ success: true, skipped: 'supabase' });
    }
    const body = req.body || {};
    const repId = String(body.agentId || body.repId || 'unknown').trim() || 'unknown';
    const agentName = String(body.agentName || '').trim();
    const agentLoadLevel = String(body.agentLoadLevel || 'LOW').toUpperCase();
    const qaScore = Math.max(0, Math.min(100, Math.round(Number(body.qaScore)) || 0));
    const callStreak = Math.max(0, Math.floor(Number(body.callStreak)) || 0);
    const isOnCall = Boolean(body.isOnCall);
    const echoShieldActive = Boolean(body.echoShieldActive);
    const status = String(body.status || '').trim();
    const callStartedAt = body.callStartedAt ? new Date(body.callStartedAt).toISOString() : null;
    const nowIso = new Date().toISOString();
    const nowMs = Date.now();

    const { data: existing, error: readErr } = await supabase
      .from('echoassist_users')
      .select('high_load_timestamps, call_started_at, is_on_call, supervisor_email, agent_email, agent_name')
      .eq('rep_id', repId)
      .maybeSingle();
    if (readErr) console.warn('[heartbeat read]', readErr.message);

    let highLoads = parseHighLoadTimestamps(existing?.high_load_timestamps);
    const hourAgo = nowMs - 3600000;
    highLoads = highLoads.filter((t) => {
      const ts = new Date(t).getTime();
      return !Number.isNaN(ts) && ts >= hourAgo;
    });

    if (agentLoadLevel === 'HIGH') {
      const last = highLoads[highLoads.length - 1];
      const lastBucket = last ? minuteBucketUtc(last) : '';
      const thisBucket = minuteBucketUtc(nowIso);
      if (thisBucket && thisBucket !== lastBucket) {
        highLoads.push(nowIso);
      } else if (!last) {
        highLoads.push(nowIso);
      }
    }

    let call_started_at = existing?.call_started_at || null;
    if (isOnCall) {
      if (!call_started_at) {
        call_started_at = callStartedAt || nowIso;
      }
    } else {
      call_started_at = null;
    }

    const row = {
      rep_id: repId,
      agent_name: agentName || existing?.agent_name || null,
      supervisor_email: existing?.supervisor_email ?? null,
      agent_email: existing?.agent_email ?? null,
      last_seen: nowIso,
      last_status: status || null,
      agent_load_level: agentLoadLevel,
      qa_score_current: qaScore,
      call_streak: callStreak,
      is_on_call: isOnCall,
      echo_shield_active: echoShieldActive,
      recovery_mode: /RECOVERY/i.test(status),
      high_load_timestamps: highLoads,
      call_started_at
    };

    const { error: upErr } = await supabase.from('echoassist_users').upsert(row, { onConflict: 'rep_id' });
    if (upErr) {
      console.error('[echoassist-heartbeat]', upErr);
      return res.status(500).json({ success: false, error: upErr.message });
    }
    return res.json({ success: true });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ success: false, error: e.message || 'heartbeat failed' });
  }
});

/**
 * POST /supervisor-data
 * Body: { supervisorKey }
 */
app.post('/supervisor-data', async (req, res) => {
  try {
    const { supervisorKey } = req.body || {};
    if (!validSupervisorKey(supervisorKey)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    
    if (!supabase) {
      return res.json({
        agents: [],
        alerts: [],
        callHistory: [],
        floorStats: { totalActive: 0, onCall: 0, highLoadCount: 0, avgQAScore: null }
      });
    }

    const startOfDay = new Date();
    startOfDay.setUTCHours(0, 0, 0, 0);
    const startIso = startOfDay.toISOString();

    const [{ data: users, error: uErr }, { data: alertsRaw, error: aErr }, { data: historyRaw, error: hErr }, { data: todayScores, error: tErr }] =
      await Promise.all([
        supabase.from('echoassist_users').select('*'),
        supabase.from('supervisor_alerts').select('*').order('created_at', { ascending: false }).limit(50),
        supabase.from('call_history').select('*').order('created_at', { ascending: false }).limit(50),
        supabase.from('call_history').select('qa_score').gte('created_at', startIso)
      ]);

    if (uErr) console.warn('[supervisor-data users]', uErr.message);
    if (aErr) console.warn('[supervisor-data alerts]', aErr.message);
    if (hErr) console.warn('[supervisor-data history]', hErr.message);
    if (tErr) console.warn('[supervisor-data today qa]', tErr.message);

    const nowMs = Date.now();
    const agents = (users || []).map((row) => {
      const lastSeen = row.last_seen ? new Date(row.last_seen).getTime() : 0;
      const online = lastSeen > 0 && nowMs - lastSeen <= 30000;
      const load = String(row.agent_load_level || 'LOW').toUpperCase();

      let statusBadge = 'OFFLINE';
      if (online) {
        if (row.recovery_mode) statusBadge = 'RECOVERY MODE';
        else if (load === 'HIGH') statusBadge = 'HIGH LOAD';
        else if (row.is_on_call) statusBadge = 'ON CALL';
        else statusBadge = 'AVAILABLE';
      }

      const highLoads = parseHighLoadTimestamps(row.high_load_timestamps);
      const uniqueHighMinutes = new Set(highLoads.map(minuteBucketUtc).filter(Boolean));
      const burnoutWarning = uniqueHighMinutes.size >= 3;

      let callDurationSeconds = 0;
      if (online && row.is_on_call && row.call_started_at) {
        const t0 = new Date(row.call_started_at).getTime();
        if (!Number.isNaN(t0)) callDurationSeconds = Math.max(0, Math.floor((nowMs - t0) / 1000));
      }

      return {
        agentId: row.rep_id,
        agentName: row.agent_name || row.rep_id,
        statusBadge,
        lastSeen: row.last_seen,
        callDurationSeconds,
        callStartedAt: row.call_started_at || null,
        agentLoadLevel: load || 'LOW',
        qaScore: Number(row.qa_score_current) || 0,
        callStreak: Number(row.call_streak) || 0,
        echoShieldActive: Boolean(row.echo_shield_active),
        burnoutWarning,
        recoveryMode: Boolean(row.recovery_mode)
      };
    });

    const onlineAgents = agents.filter((a) => a.statusBadge !== 'OFFLINE');
    const onCall = onlineAgents.filter((a) => a.statusBadge === 'ON CALL').length;
    const highLoadCount = onlineAgents.filter((a) => a.statusBadge === 'HIGH LOAD').length;

    let avgQAScore = null;
    const tlist = todayScores || [];
    if (tlist.length > 0) {
      const sum = tlist.reduce((acc, r) => acc + (Number(r.qa_score) || 0), 0);
      avgQAScore = Math.round(sum / tlist.length);
    }

    const floorStats = {
      totalActive: onlineAgents.length,
      onCall,
      highLoadCount,
      avgQAScore
    };

    const alerts = (alertsRaw || []).map((r) => {
      let alertType = r.alert_type || '';
      const msg = r.message || '';
      if (!alertType) {
        const lvl = String(r.agent_load_level || '').toUpperCase();
        if (lvl === 'HIGH') alertType = 'HIGH LOAD';
        else alertType = 'SUPERVISOR FLAG';
      }
      return {
        id: r.id,
        created_at: r.created_at || r.timestamp,
        rep_id: r.rep_id,
        agent_name: r.agent_name || r.rep_id,
        alert_type: alertType,
        message: msg || `Load ${r.agent_load_level || '—'} · calls ${r.session_call_count ?? '—'}`
      };
    });

    const callHistory = (historyRaw || []).map((r) => ({
      id: r.id,
      agent_id: r.agent_id,
      agent_name: r.agent_name,
      created_at: r.created_at,
      duration_seconds: r.duration_seconds,
      qa_score: r.qa_score,
      rep_score: r.rep_score,
      churn_risk: r.churn_risk,
      outcome: r.outcome,
      flags: r.flags || []
    }));

    return res.json({ agents, alerts, callHistory, floorStats });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message || 'supervisor-data failed' });
  }
});

/**
 * POST /echoassist-supervisor-checkin
 * Body: { agentId }
 */
app.post('/echoassist-supervisor-checkin', async (req, res) => {
  try {
    const body = req.body || {};
    if (!validSupervisorKey(body.supervisorKey)) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    const agentId = String(body.agentId || '').trim();
    if (!agentId) {
      return res.status(400).json({ success: false, error: 'agentId required' });
    }
    if (!RESEND_API_KEY || !RESEND_FROM) {
      return res.status(500).json({ success: false, error: 'Resend not configured' });
    }
    
    if (!supabase) {
      return res.status(500).json({ success: false, error: 'Supabase not configured' });
    }
    const { data: userRow, error: userErr } = await supabase
      .from('echoassist_users')
      .select('agent_email, agent_name')
      .eq('rep_id', agentId)
      .maybeSingle();
    if (userErr) console.warn('[checkin user]', userErr.message);
    const to = userRow?.agent_email;
    if (!to || typeof to !== 'string') {
      return res.status(404).json({ success: false, error: 'No agent email on file' });
    }
    const resend = new Resend(RESEND_API_KEY);
    await resend.emails.send({
      from: RESEND_FROM,
      to,
      subject: 'Your supervisor wants to check in',
      text: 'Your supervisor has requested a quick check-in. Please reach out when you have a moment.'
    });

    const agentName = userRow?.agent_name || agentId;
    const { error: alertInsErr } = await supabase.from('supervisor_alerts').insert({
      rep_id: agentId,
      agent_name: agentName,
      alert_type: 'CHECK-IN REQUEST',
      message: 'Supervisor requested a check-in.',
      agent_load_level: '',
      session_call_count: 0,
      timestamp: new Date().toISOString()
    });
    if (alertInsErr) console.warn('[supervisor_alerts checkin]', alertInsErr.message);

    return res.json({ success: true });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ success: false, error: e.message || 'checkin failed' });
  }
});



app.listen(PORT, () => {
  console.log(`EchoPulse server running on port ${PORT}`);
});