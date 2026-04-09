const { SIGNALS, getRiskLevel } = require('./signals');

// In-memory store for customer scores
// We'll move this to Supabase next session
const customerScores = {};

function processEvent(eventType, customerId, customerEmail) {
  if (!customerId) return null;

  // Get signal weight for this event
  const signalWeight = SIGNALS[eventType];
  
  // If we don't recognize this event, ignore it
  if (signalWeight === undefined) return null;

  // Initialize customer if we haven't seen them before
  if (!customerScores[customerId]) {
    customerScores[customerId] = {
      customerId,
      customerEmail: customerEmail || 'Unknown',
      score: 0,
      signals: [],
      lastUpdated: new Date().toISOString(),
    };
  }

  // Add the signal weight to their score
  customerScores[customerId].score += signalWeight;
  customerScores[customerId].signals.push({
    event: eventType,
    weight: signalWeight,
    timestamp: new Date().toISOString(),
  });
  customerScores[customerId].lastUpdated = new Date().toISOString();
customerScores[customerId].score = customerScores[customerId].score;
  // Get their current risk level
  const score = customerScores[customerId].score;
  const riskLevel = getRiskLevel(score);

  const result = {
    customerId,
    customerEmail: customerScores[customerId].customerEmail,
    score,
    riskLevel,
    signals: customerScores[customerId].signals,
    shouldAlert: riskLevel.label === 'Yellow' || 
                 riskLevel.label === 'Red',
  };

  return result;
}

function getAllCustomers() {
  return Object.values(customerScores);
}

module.exports = { processEvent, getAllCustomers };