const axios = require("axios");
const { createClient } = require("@supabase/supabase-js");
const Anthropic = require("@anthropic-ai/sdk");
const { sendChurnAlert } = require("../mailer");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeCompanyKey(name) {
  if (name === null || name === undefined) return null;
  const s = String(name).trim();
  return s.length ? s.toLowerCase() : null;
}

function quoteCompanyForQuery(companyName) {
  return String(companyName).replace(/"/g, " ").trim();
}

function buildNewsQuery(companyName) {
  const safe = quoteCompanyForQuery(companyName);
  return `"${safe}" AND (layoffs OR acquisition OR "CEO leaves" OR restructuring OR bankrupt)`;
}

function formatArticleDescription(articles) {
  return articles
    .map((a) => {
      const title = a?.title || "Untitled";
      const source = a?.source?.name || "Unknown source";
      return `${title} — ${source}`;
    })
    .join(" | ");
}

function sevenDaysAgoYyyyMmDd() {
  const d = new Date();
  d.setDate(d.getDate() - 7);
  return d.toISOString().slice(0, 10);
}

function buildClaudePrompt(companyName, articles) {
  const articleLines = (articles || [])
    .map((a) => {
      const title = a?.title || "Untitled";
      const source = a?.source?.name || "Unknown source";
      return `- ${title} (${source})`;
    })
    .join("\n");

  return `You are a B2B churn intelligence analyst.
Analyze these news articles about ${companyName} 
and determine if any indicate genuine churn risk 
for a B2B software vendor who has this company 
as a customer.

Churn-relevant signals are:
- Layoffs or workforce reductions
- Acquisition or merger activity  
- CEO or key executive departures
- Budget cuts or cost reduction programs
- Bankruptcy or financial distress
- Major restructuring

Articles: ${articleLines}

Respond ONLY with valid JSON:
{
  churn_relevant: true or false,
  risk_score: number between 0-100,
  risk_reason: one sentence explaining the risk,
  recommended_action: specific action to take,
  urgency: immediate or this_week or monitor or none
}`;
}

function clampRiskScore(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return null;
  return Math.max(0, Math.min(100, Math.round(x)));
}

function extractClaudeText(resp) {
  const content = resp?.content;
  if (!Array.isArray(content)) return null;
  const textParts = content
    .map((c) => (c && typeof c.text === "string" ? c.text : null))
    .filter(Boolean);
  return textParts.length ? textParts.join("\n").trim() : null;
}

async function runNewsMonitor() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  const newsApiKey = process.env.NEWS_API_KEY;
  const anthropicApiKey = process.env.ANTHROPIC_API_KEY;

  if (!url || !key) {
    throw new Error("Supabase not configured (SUPABASE_URL/SUPABASE_KEY)");
  }
  if (!newsApiKey) {
    throw new Error("NEWS_API_KEY is not set");
  }
  if (!anthropicApiKey) {
    throw new Error("ANTHROPIC_API_KEY is not set");
  }

  const supabase = createClient(url, key);
  const anthropic = new Anthropic({ apiKey: anthropicApiKey });

  const { data: rows, error: fetchError } = await supabase
    .from("monitored_contacts")
    .select("id, user_id, stripe_customer_id, company_name");

  if (fetchError) throw fetchError;

  const groups = new Map();
  for (const row of rows || []) {
    const displayName = row.company_name?.trim();
    const groupKey = normalizeCompanyKey(displayName);
    if (!groupKey || !displayName) continue;

    if (!groups.has(groupKey)) {
      groups.set(groupKey, { displayName, contacts: [] });
    }
    groups.get(groupKey).contacts.push(row);
  }

  const companies = Array.from(groups.values());
  console.log(`[EchoPulse] News monitor: ${companies.length} unique companies to check.`);

  for (let i = 0; i < companies.length; i += 1) {
    const { displayName, contacts } = companies[i];
    console.log(
      `[EchoPulse] News monitor [${i + 1}/${companies.length}]: ${displayName}`,
    );

    try {
      const resp = await axios.get("https://newsapi.org/v2/everything", {
        params: {
          apiKey: newsApiKey,
          q: buildNewsQuery(displayName),
          from: sevenDaysAgoYyyyMmDd(),
          sortBy: "publishedAt",
          pageSize: 3,
          page: 1,
        },
        timeout: 20_000,
        validateStatus: (s) => s >= 200 && s < 300,
      });

      const articles = Array.isArray(resp.data?.articles) ? resp.data.articles : [];

      if (articles.length === 0) {
        console.log(`[EchoPulse]   No matching articles for "${displayName}".`);
      } else {
        const prompt = buildClaudePrompt(displayName, articles);

        let claudeJson = null;
        try {
          const msg = await anthropic.messages.create({
            model: "claude-sonnet-4-5",
            max_tokens: 400,
            temperature: 0,
            messages: [{ role: "user", content: prompt }],
          });

          const text = extractClaudeText(msg);
if (text) {
  const clean = text
    .replace(/```json/g, '')
    .replace(/```/g, '')
    .trim();
  claudeJson = JSON.parse(clean);
}
        } catch (e) {
          console.error(
            `[EchoPulse]   Claude analysis failed for "${displayName}":`,
            e?.message || e,
          );
          claudeJson = null;
        }

        const churnRelevant = Boolean(claudeJson?.churn_relevant);

        if (!churnRelevant) {
          console.log(`[EchoPulse] No churn-relevant news for ${displayName}`);
        } else {
          const primary = contacts[0];
          const signalDescription = formatArticleDescription(articles);
          const riskScore = clampRiskScore(claudeJson?.risk_score) ?? 0;
          const recommendedAction =
            typeof claudeJson?.recommended_action === "string" &&
            claudeJson.recommended_action.trim().length
              ? claudeJson.recommended_action.trim()
              : "Review account immediately";

          const riskReason =
            typeof claudeJson?.risk_reason === "string" ? claudeJson.risk_reason.trim() : "";
          const urgency = typeof claudeJson?.urgency === "string" ? claudeJson.urgency.trim() : "";

          const enrichedDescription =
            riskReason || urgency
              ? `${signalDescription} | AI: ${riskReason || "Churn risk detected."}${
                  urgency ? ` (urgency: ${urgency})` : ""
                }`
              : signalDescription;

          const { error: insertError } = await supabase.from("churn_signals").insert({
            contact_id: primary.id,
            user_id: primary.user_id,
            stripe_customer_id: primary.stripe_customer_id,
            company_name: primary.company_name,
            signal_type: "NEWS_ALERT",
            risk_score: riskScore,
            signal_description: enrichedDescription,
            recommended_action: recommendedAction,
          });

          if (insertError) {
            console.error(
              `[EchoPulse]   Failed to insert churn_signal for "${displayName}":`,
              insertError.message,
            );
          } else {
            console.log(
              `[EchoPulse]   Inserted NEWS_ALERT (${articles.length} article(s) cited).`,
            );
          }
        }
      }
    } catch (err) {
      console.error(
        `[EchoPulse]   NewsAPI error for "${displayName}":`,
        err?.response?.data || err?.message || err,
      );
    }

    if (i < companies.length - 1) {
      await sleep(1000);
    }
  }

  try {
    const { data: pendingSignals, error: pendingError } = await supabase
      .from("churn_signals")
      .select("*")
      .eq("alert_sent", false);

    if (pendingError) throw pendingError;

    for (const signal of pendingSignals || []) {
      try {
        const customer = {
          stripe_customer_id: signal.stripe_customer_id,
          risk_level: "yellow",
          risk_score: signal.risk_score,
          email: "Unknown",
          signals: [signal.signal_type],
        };

        const assessment = {
          stage: signal.signal_type,
          assessment: signal.signal_description,
          email_subject: `EchoPulse Alert — ${signal.signal_type}`,
          email_body: `${signal.signal_description}\n\nRecommended action: ${signal.recommended_action}`,
        };

        await sendChurnAlert(customer, assessment);

        const { error: updateError } = await supabase
          .from("churn_signals")
          .update({ alert_sent: true })
          .eq("id", signal.id);

        if (updateError) {
          console.error(
            `[EchoPulse] Failed to mark alert_sent for signal ${signal.id}:`,
            updateError.message,
          );
        }
      } catch (err) {
        console.error(
          `[EchoPulse] Failed sending alert for signal ${signal?.id}:`,
          err?.message || err,
        );
      }
    }
  } catch (err) {
    console.error(
      "[EchoPulse] Failed processing pending alerts:",
      err?.message || err,
    );
  }

  console.log("[EchoPulse] News monitor complete.");
}

module.exports = {
  runNewsMonitor,
};
