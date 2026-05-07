const rateLimit = require("express-rate-limit");

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // 100 requests per window per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: "Too many requests",
    message: "Rate limit exceeded. Try again later.",
  },
});

const strictLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 20, // 20 requests per window per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: "Too many requests",
    message: "Rate limit exceeded. Try again later.",
  },
});

module.exports = {
  apiLimiter,
  strictLimiter,
};
