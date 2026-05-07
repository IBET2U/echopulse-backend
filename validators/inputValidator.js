const Joi = require("joi");

const contactSchema = Joi.object({
  stripeCustomerId: Joi.string().required(),
  companyName: Joi.string().max(100).required(),
  contactEmail: Joi.string().email().required(),
  contactName: Joi.string().max(100).optional(),
  linkedinUrl: Joi.string().uri().optional(),
});

const stripeWebhookSchema = Joi.object({
  customerId: Joi.string().required(),
  email: Joi.string().email().required(),
  companyName: Joi.string().optional(),
});

function validateContact(payload) {
  return contactSchema.validate(payload, {
    abortEarly: false,
    stripUnknown: true,
  });
}

function validateStripeWebhook(payload) {
  return stripeWebhookSchema.validate(payload, {
    abortEarly: false,
    stripUnknown: true,
  });
}

module.exports = {
  validateContact,
  validateStripeWebhook,
};
