const axios = require("axios");
const { createClient } = require("@supabase/supabase-js");
const { enrichContact } = require("./contactEnricher");

let _supabaseClient = null;
function getSupabase() {
  if (_supabaseClient) return _supabaseClient;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
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
    const apiKey = process.env.PROXYCURL_API_KEY;
    const linkedinUrl = normalizeStr(contactEmail);
    if (!apiKey || !linkedinUrl) return null;

    const resp = await axios.get("https://nubela.co/proxycurl/api/v2/linkedin", {
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      params: {
        url: linkedinUrl,
      },
      timeout: 25_000,
      validateStatus: (s) => s >= 200 && s < 300,
    });

    const exp0 = Array.isArray(resp?.data?.experiences) ? resp.data.experiences[0] : null;
    const currentCompany = normalizeStr(exp0?.company);
    const currentTitle = normalizeStr(exp0?.title);

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

    const linkedinUrl = normalizeStr(contact.linkedin_url);
    if (!linkedinUrl) return { changed: false, details: "Missing linkedin_url" };

    const profile = await fetchContactProfile(linkedinUrl);
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
      "id,user_id,stripe_customer_id,company_name,contact_name,contact_email,linkedin_url,current_company,current_job_title",
    );

  if (error) throw error;

  const total = Array.isArray(contacts) ? contacts.length : 0;
  console.log(`[EchoPulse] Found ${total} contacts to scan.`);

  for (let i = 0; i < total; i += 1) {
    const c = contacts[i];
    const label = `${c.company_name || "Unknown Company"} (${c.id})`;

    console.log(`[EchoPulse] [${i + 1}/${total}] Checking ${label}...`);

    if (!normalizeStr(c.linkedin_url)) {
      const email = normalizeStr(c.contact_email);
      const emailDomain =
        email && email.includes("@") ? normalizeStr(email.split("@").pop()) : null;

      const company = normalizeStr(c.company_name);
      let fullCompanyDomain = null;
      let firstWordDomain = null;
      if (company) {
        const slugFull = company
          .toLowerCase()
          .replace(/\b(inc|inc\.|llc|ltd|ltd\.|corp|corp\.|co|co\.|company|group|holdings)\b/g, "")
          .replace(/[^a-z0-9]/g, "")
          .trim();
        if (slugFull) fullCompanyDomain = `${slugFull}.com`;

        const firstWord = company
          .split(/\s+/)[0]
          ?.toLowerCase()
          .replace(/[^a-z0-9]/g, "")
          .trim();
        if (firstWord) firstWordDomain = `${firstWord}.com`;
      }

      const domainCandidates = [];
      if (emailDomain) domainCandidates.push(emailDomain);
      if (fullCompanyDomain && fullCompanyDomain !== emailDomain) {
        domainCandidates.push(fullCompanyDomain);
      }
      if (
        firstWordDomain &&
        firstWordDomain !== emailDomain &&
        firstWordDomain !== fullCompanyDomain
      ) {
        domainCandidates.push(firstWordDomain);
      }

      let enriched = null;
      let lastDomainTried = null;

      if (domainCandidates.length === 0) {
        console.log(
          `[EchoPulse] [${i + 1}/${total}] PDL enrich: no domain could be derived (no email domain / company name).`,
        );
      }

      for (const companyDomain of domainCandidates) {
        lastDomainTried = companyDomain;
        console.log(
          `[EchoPulse] [${i + 1}/${total}] PDL enrich trying domain: ${companyDomain}`,
        );
        try {
          enriched = await enrichContact(companyDomain, c.company_name);
        } catch (_err) {
          enriched = null;
        }
        if (enriched) {
          console.log(
            `[EchoPulse] [${i + 1}/${total}] PDL/Hunter enrich returned a result for domain: ${companyDomain}`,
          );
          console.log(
            `[EchoPulse] [${i + 1}/${total}] LinkedIn URL found: ${enriched.linkedinUrl || "(none)"}`,
          );
          break;
        }
        console.log(
          `[EchoPulse] [${i + 1}/${total}] PDL/Hunter enrich returned no result for domain: ${companyDomain}`,
        );
      }

      if (domainCandidates.length > 0 && !enriched) {
        console.log(
          `[EchoPulse] [${i + 1}/${total}] PDL/Hunter enrich: no contact after all domain attempts (last tried: ${lastDomainTried})`,
        );
        console.log(`[EchoPulse] [${i + 1}/${total}] LinkedIn URL found: (none)`);
      }

      if (enriched) {
        const updatePayload = {
          contact_name: enriched.name,
          contact_email: enriched.email,
          linkedin_url: enriched.linkedinUrl,
          current_job_title: enriched.currentTitle,
          current_company: enriched.currentCompany,
          updated_at: new Date().toISOString(),
        };

        const { error: updateError } = await supabase
          .from("monitored_contacts")
          .update(updatePayload)
          .eq("id", c.id);

        if (updateError) {
          console.error(
            `[EchoPulse] [${i + 1}/${total}] Failed to update enriched contact for ${label}:`,
            updateError.message,
          );
        } else {
          c.contact_name = enriched.name;
          c.contact_email = enriched.email;
          c.linkedin_url = enriched.linkedinUrl;
          c.current_job_title = enriched.currentTitle;
          c.current_company = enriched.currentCompany;
        }
      }
    }

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
