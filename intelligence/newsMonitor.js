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

function buildClaudePrompt(companyName, articles, companyContext) {
  const articleLines = (articles || [])
    .map((a) => {
      const title = a?.title || "Untitled";
      const source = a?.source?.name || "Unknown source";
      return `- ${title} (${source})`;
    })
    .join("\n");

  return `You are a B2B churn intelligence analyst for a software vendor.

Your vendor has a B2B customer called "${companyName}".
${companyContext ? `What we know about this customer: ${companyContext}` : ''}

Analyze these recent news articles about ${companyName} and determine 
if any indicate that this SPECIFIC customer is at risk of cancelling 
their B2B software subscription.

Only flag as churn-relevant if the news directly suggests:
1. Budget cuts that would affect their software spending
2. Layoffs that would eliminate the team using the software
3. Acquisition where new owners typically audit and cut vendor contracts
4. Key executive departure who was the champion of this software
5. Company bankruptcy or severe financial distress
6. Major restructuring that would change their technology needs

Do NOT flag as churn-relevant:
- General industry news unrelated to their ability to pay
- Product launches or partnerships
- News about their customers (not the company itself)
- Stock price movements without financial distress signals
- Awards, rankings, or positive news

Articles to analyze:
${articleLines}

Respond ONLY with valid JSON no markdown:
{
  "churn_relevant": true or false,
  "risk_score": number 0-100,
  "risk_reason": "one specific sentence explaining exactly why this is a churn risk",
  "recommended_action": "one specific action the vendor should take this week",
  "urgency": "immediate or this_week or monitor or none",
  "signal_category": "layoffs or acquisition or leadership_change or financial_distress or restructuring or none"
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
  const anthropicApiKey = process.env.ANTHROPIC_API_KEY;

  if (!url || !key) {
    throw new Error("Supabase not configured (SUPABASE_URL/SUPABASE_KEY)");
  }
  if (!anthropicApiKey) {
    throw new Error("ANTHROPIC_API_KEY is not set");
  }

  const supabase = createClient(url, key);
  const anthropic = new Anthropic({ apiKey: anthropicApiKey });

  const { data: rows, error: fetchError } = await supabase
    .from("monitored_contacts")
    .select("id, user_id, stripe_customer_id, company_name, contact_email, business_description");

  if (fetchError) throw fetchError;

  const groups = new Map();
  for (const row of rows || []) {
    const displayName = row.company_name?.trim();
    const groupKey = normalizeCompanyKey(displayName);
    if (!groupKey || !displayName) continue;

    if (!groups.has(groupKey)) {
      groups.set(groupKey, {
        displayName,
        contacts: [],
        businessDescription: row.business_description || "",
      });
    }
    groups.get(groupKey).contacts.push(row);
  }

  const companies = Array.from(groups.values());
  console.log(`[EchoPulse] News monitor: ${companies.length} unique companies to check.`);

  for (let i = 0; i < companies.length; i += 1) {
    const { displayName, contacts, businessDescription } = companies[i];
    console.log(
      `[EchoPulse] News monitor [${i + 1}/${companies.length}]: ${displayName}`,
    );

    try {
      const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(displayName)}&hl=en-US&gl=US&ceid=US:en`;
      const rssResp = await axios.get(rssUrl, { timeout: 20_000 });

      const rssXml = typeof rssResp?.data === "string" ? rssResp.data : "";
      const itemBlocks = rssXml.split("<item>").slice(1);
      const parsedItems = [];

      for (const block of itemBlocks) {
        if (parsedItems.length >= 5) break;
        const itemXml = block.split("</item>")[0] || "";

        const titleStart = itemXml.indexOf("<title>");
        const titleEnd = itemXml.indexOf("</title>");
        let title =
          titleStart !== -1 && titleEnd !== -1 && titleEnd > titleStart
            ? itemXml.slice(titleStart + "<title>".length, titleEnd).trim()
            : "Untitled";
        title = title.replace(/^<!\[CDATA\[/, "").replace(/\]\]>$/, "").trim() || "Untitled";

        const sourceStart = itemXml.indexOf("<source>");
        const sourceEnd = itemXml.indexOf("</source>");
        let sourceName =
          sourceStart !== -1 && sourceEnd !== -1 && sourceEnd > sourceStart
            ? itemXml.slice(sourceStart + "<source>".length, sourceEnd).trim()
            : "Unknown source";
        sourceName =
          sourceName.replace(/^<!\[CDATA\[/, "").replace(/\]\]>$/, "").trim() ||
          "Unknown source";

        parsedItems.push({ title, source: { name: sourceName } });
      }

      const articles = parsedItems;

      if (articles.length === 0) {
        console.log(`[EchoPulse]   No matching articles for "${displayName}".`);
      } else {
        const prompt = buildClaudePrompt(displayName, articles, businessDescription);

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
