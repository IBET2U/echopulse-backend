const axios = require("axios");
const { createClient } = require("@supabase/supabase-js");

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

async function runNewsMonitor() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_KEY;
  const newsApiKey = process.env.NEWS_API_KEY;

  if (!url || !key) {
    throw new Error("Supabase not configured (SUPABASE_URL/SUPABASE_KEY)");
  }
  if (!newsApiKey) {
    throw new Error("NEWS_API_KEY is not set");
  }

  const supabase = createClient(url, key);

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
        const signalDescription = formatArticleDescription(articles);
        const recommendedAction = "Review account immediately";
        const primary = contacts[0];

        const { error: insertError } = await supabase.from("churn_signals").insert({
          contact_id: primary.id,
          user_id: primary.user_id,
          stripe_customer_id: primary.stripe_customer_id,
          company_name: primary.company_name,
          signal_type: "NEWS_ALERT",
          risk_score: 70,
          signal_description: signalDescription,
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

  console.log("[EchoPulse] News monitor complete.");
}

module.exports = {
  runNewsMonitor,
};
