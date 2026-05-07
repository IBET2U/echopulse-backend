const axios = require("axios");
const { createClient } = require("@supabase/supabase-js");

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeStr(value) {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s.length ? s : null;
}

async function fetchContactProfile(contactEmail) {
  try {
    const apiKey = process.env.APOLLO_API_KEY;
    const email = normalizeStr(contactEmail);
    if (!apiKey || !email) return null;

    const resp = await axios.post(
      "https://api.apollo.io/v1/people/search",
      {
        q_keywords: email,
        page: 1,
        per_page: 1,
      },
      {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-cache",
          "X-Api-Key": apiKey,
        },
        timeout: 20_000,
        validateStatus: (s) => s >= 200 && s < 300,
      },
    );

    const people = resp.data?.people;
    const person = Array.isArray(people) && people.length > 0 ? people[0] : null;
    if (!person) return null;

    const currentCompany = normalizeStr(person.organization?.name);
    const currentTitle = normalizeStr(person.title);
    if (!currentCompany && !currentTitle) return null;

    return { currentCompany, currentTitle };
  } catch (_err) {
    return null;
  }
}

async function checkChampionStatus(contact) {
  try {
    const supabase = getSupabase();
    if (!contact || typeof contact !== "object") return { changed: false, details: "Invalid contact" };

    const contactEmail = normalizeStr(contact.contact_email);
    if (!contactEmail) return { changed: false, details: "Missing contact_email" };

    const profile = await fetchContactProfile(contactEmail);
    if (!profile) return { changed: false, details: "Failed to fetch contact profile" };

    const fetchedCompany = profile.currentCompany;
    const fetchedTitle = profile.currentTitle;

    const storedCompany = normalizeStr(contact.current_company);
    const storedTitle = normalizeStr(contact.current_job_title);

    const companyChanged =
      fetchedCompany && storedCompany
        ? fetchedCompany.toLowerCase() !== storedCompany.toLowerCase()
        : fetchedCompany !== storedCompany;
    const titleChanged =
      fetchedTitle && storedTitle
        ? fetchedTitle.toLowerCase() !== storedTitle.toLowerCase()
        : fetchedTitle !== storedTitle;

    const changed = Boolean(companyChanged || titleChanged);

    if (!changed) {
      return {
        changed: false,
        details: {
          contactId: contact.id,
          storedCompany,
          storedTitle,
          fetchedCompany,
          fetchedTitle,
        },
      };
    }

    const parts = [];
    if (companyChanged) parts.push(`company changed from "${storedCompany || "unknown"}" to "${fetchedCompany || "unknown"}"`);
    if (titleChanged) parts.push(`title changed from "${storedTitle || "unknown"}" to "${fetchedTitle || "unknown"}"`);

    const signalDescription = `Champion update detected: ${parts.join("; ")}.`;
    const recommendedAction = `Reach out to ${normalizeStr(contact.company_name) || "the company"} to confirm the champion's status and identify the new internal owner.`;

    const insertRes = await supabase.from("churn_signals").insert({
      contact_id: contact.id,
      user_id: contact.user_id,
      stripe_customer_id: contact.stripe_customer_id,
      company_name: contact.company_name,
      signal_type: "CHAMPION_LEFT",
      risk_score: 85,
      signal_description: signalDescription,
      recommended_action: recommendedAction,
    });

    if (insertRes.error) throw insertRes.error;

    const updateRes = await supabase
      .from("monitored_contacts")
      .update({
        current_company: fetchedCompany,
        current_job_title: fetchedTitle,
        updated_at: new Date().toISOString(),
      })
      .eq("id", contact.id);

    if (updateRes.error) throw updateRes.error;

    return {
      changed: true,
      details: {
        contactId: contact.id,
        storedCompany,
        storedTitle,
        fetchedCompany,
        fetchedTitle,
        signal_description: signalDescription,
      },
    };
  } catch (err) {
    return {
      changed: false,
      details: err?.message || "Unknown error",
    };
  }
}

async function runChampionScan() {
  const supabase = getSupabase();

  console.log("[EchoPulse] Champion scan starting...");

  const { data: contacts, error } = await supabase
    .from("monitored_contacts")
    .select(
      "id,user_id,stripe_customer_id,company_name,contact_name,contact_email,current_company,current_job_title",
    )
    .not("contact_email", "is", null);

  if (error) throw error;

  const total = Array.isArray(contacts) ? contacts.length : 0;
  console.log(`[EchoPulse] Found ${total} contacts to scan.`);

  for (let i = 0; i < total; i += 1) {
    const c = contacts[i];
    const label = `${c.company_name || "Unknown Company"} (${c.id})`;

    console.log(`[EchoPulse] [${i + 1}/${total}] Checking ${label}...`);
    const result = await checkChampionStatus(c);

    if (result.changed) {
      console.log(`[EchoPulse] [${i + 1}/${total}] Change detected for ${label}`);
    } else {
      console.log(`[EchoPulse] [${i + 1}/${total}] No change for ${label}`);
    }

    if (i < total - 1) {
      await sleep(2000);
    }
  }

  console.log("[EchoPulse] Champion scan complete.");
}

module.exports = {
  checkChampionStatus,
  runChampionScan,
};
