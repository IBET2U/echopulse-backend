const express = require("express");
const { createClient } = require("@supabase/supabase-js");

const { validateContact } = require("../validators/inputValidator");
const { strictLimiter } = require("../middleware/rateLimiter");
const { runChampionScan } = require("../intelligence/championMonitor");
const { runNewsMonitor } = require("../intelligence/newsMonitor");

const router = express.Router();

let _supabaseClient = null;
function getSupabase() {
  if (_supabaseClient) return _supabaseClient;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_KEY;
  if (!url || !key) {
    throw new Error("Supabase not configured (SUPABASE_URL/SUPABASE_KEY)");
  }

  _supabaseClient = createClient(url, key);
  return _supabaseClient;
}

function getAuthenticatedUserId(req) {
  return (
    req?.user?.id ||
    req?.user?.user_id ||
    req?.auth?.userId ||
    req?.auth?.user_id ||
    req?.userId ||
    req?.user_id ||
    null
  );
}

router.post("/contacts", async (req, res) => {
  try {
    const supabase = getSupabase();

    const userId = getAuthenticatedUserId(req);
    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { value, error } = validateContact(req.body);
    if (error) {
      return res.status(400).json({
        error: "Validation error",
        details: error.details?.map((d) => d.message) || [],
      });
    }

    const payload = {
      user_id: userId,
      stripe_customer_id: value.stripeCustomerId,
      company_name: value.companyName,
      contact_email: value.contactEmail,
      contact_name: value.contactName || null,
      linkedin_url: value.linkedinUrl || null,
    };

    const { data, error: insertError } = await supabase
      .from("monitored_contacts")
      .insert(payload)
      .select("*")
      .single();

    if (insertError) {
      return res.status(500).json({ error: insertError.message });
    }

    return res.status(201).json(data);
  } catch (err) {
    return res.status(500).json({ error: err?.message || "Server error" });
  }
});

router.get("/contacts", async (req, res) => {
  try {
    const supabase = getSupabase();

    const userId = getAuthenticatedUserId(req);
    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { data, error } = await supabase
      .from("monitored_contacts")
      .select("*")
      .eq("user_id", userId)
      .order("created_at", { ascending: false });

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    return res.json(data || []);
  } catch (err) {
    return res.status(500).json({ error: err?.message || "Server error" });
  }
});

router.get("/signals", async (req, res) => {
  try {
    const supabase = getSupabase();

    const userId = getAuthenticatedUserId(req);
    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { data, error } = await supabase
      .from("churn_signals")
      .select("*")
      .eq("user_id", userId)
      .order("created_at", { ascending: false });

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    return res.json(data || []);
  } catch (err) {
    return res.status(500).json({ error: err?.message || "Server error" });
  }
});

router.post("/scan", strictLimiter, async (_req, res) => {
  try {
    await runChampionScan();
    return res.json({ success: true, message: "Champion scan completed" });
  } catch (err) {
    return res.status(500).json({ error: err?.message || "Scan failed" });
  }
});

router.post("/news-scan", strictLimiter, async (_req, res) => {
  try {
    await runNewsMonitor();
    return res.json({ success: true, message: "News monitor completed" });
  } catch (err) {
    return res.status(500).json({ error: err?.message || "News scan failed" });
  }
});

module.exports = router;
