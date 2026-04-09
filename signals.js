// Shadow Churn Signal Weights
// Higher number = stronger shadow churn indicator

const SIGNALS = {
  // Payment signals
  'invoice.payment_failed': 40,
  'invoice.payment_action_required': 35,
  'customer.subscription.deleted': 90,
  'customer.subscription.updated': 25,
  
  // Billing signals  
  'payment_method.detached': 45,
  'customer.updated': 15,
  
  // Subscription health signals
  'customer.subscription.paused': 60,
  'invoice.voided': 50,
  
  // Positive signals (negative weight = good sign)
  'invoice.payment_succeeded': -10,
  'invoice.paid': -10,
  'customer.subscription.resumed': -30,
  'payment_intent.succeeded': -5,
};

// Risk levels based on accumulated score
const RISK_LEVELS = {
  GREEN: { min: -999, max: 29, label: 'Green', emoji: '🟢' },
  YELLOW: { min: 30, max: 59, label: 'Yellow', emoji: '🟡' },
  RED: { min: 60, max: 999, label: 'Red', emoji: '🔴' },
};

function getRiskLevel(score) {
  if (score >= RISK_LEVELS.RED.min) return RISK_LEVELS.RED;
  if (score >= RISK_LEVELS.YELLOW.min) return RISK_LEVELS.YELLOW;
  return RISK_LEVELS.GREEN;
}

module.exports = { SIGNALS, RISK_LEVELS, getRiskLevel };
