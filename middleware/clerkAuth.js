const { verifyToken } = require("@clerk/clerk-sdk-node");

function getBearerToken(req) {
  const header = req?.headers?.authorization || req?.headers?.Authorization;
  if (!header || typeof header !== "string") return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

async function requireAuth(req, res, next) {
  const secretKey = process.env.CLERK_SECRET_KEY;
  if (!secretKey) {
    return res.status(500).json({ error: "CLERK_SECRET_KEY is not set" });
  }

  const token = getBearerToken(req);
  if (!token) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const verified = await verifyToken(token, { secretKey });
    const userId = verified?.sub || null;
    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    if (!req.auth) req.auth = {};
    req.auth.userId = userId;
    return next();
  } catch (_err) {
    return res.status(401).json({ error: "Unauthorized" });
  }
}

module.exports = {
  requireAuth,
};
