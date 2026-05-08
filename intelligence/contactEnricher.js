const axios = require("axios");

function normalizeDomain(domain) {
  if (!domain || typeof domain !== "string") return null;
  const trimmed = domain.trim();
  if (!trimmed) return null;
  return trimmed
    .replace(/^https?:\/\//i, "")
    .replace(/^www\./i, "")
    .split("/")[0]
    .trim();
}

async function searchPdlSeniorContact(companyDomain) {
  const pdlApiKey = process.env.PDL_API_KEY;
  if (!pdlApiKey) return null;

  const domain = normalizeDomain(companyDomain);
  if (!domain) return null;

  const resp = await axios.post(
    "https://api.peopledatalabs.com/v5/person/search",
    {
      query: {
        bool: {
          must: [
            { term: { job_company_website: domain } },
            {
              terms: {
                job_title_role: ["customer success", "operations", "product", "engineering"],
              },
            },
            { terms: { job_title_levels: ["vp", "director", "manager", "c_suite"] } },
          ],
        },
      },
      size: 1,
      dataset: "all",
    },
    {
      headers: {
        "X-Api-Key": pdlApiKey,
        "Content-Type": "application/json",
      },
      timeout: 20_000,
      validateStatus: (s) => s >= 200 && s < 300,
    },
  );

  const results = resp?.data?.data;
  const person = Array.isArray(results) && results.length ? results[0] : null;
  if (!person) return null;

  const name = typeof person?.full_name === "string" ? person.full_name.trim() : null;
  const email = typeof person?.work_email === "string" ? person.work_email.trim() : null;
  const linkedinUrl =
    typeof person?.linkedin_url === "string" ? person.linkedin_url.trim() : null;
  const currentTitle = typeof person?.job_title === "string" ? person.job_title.trim() : null;
  const currentCompany =
    typeof person?.job_company_name === "string" ? person.job_company_name.trim() : null;

  if (!email) return null;

  return {
    name,
    email,
    linkedinUrl,
    currentTitle,
    currentCompany,
  };
}

async function enrichViaHunterAndProxycurl(companyDomain, companyName) {
  const hunterApiKey = process.env.HUNTER_API_KEY;
  const proxycurlApiKey = process.env.PROXYCURL_API_KEY;

  if (!hunterApiKey || !proxycurlApiKey) return null;

  const domain = normalizeDomain(companyDomain);
  if (!domain) return null;

  const hunterResp = await axios.get("https://api.hunter.io/v2/domain-search", {
    params: {
      domain,
      api_key: hunterApiKey,
      seniority: "senior,executive",
      limit: 1,
    },
    timeout: 15_000,
    validateStatus: (s) => s >= 200 && s < 300,
  });

  const emails = hunterResp?.data?.data?.emails;
  const top = Array.isArray(emails) && emails.length > 0 ? emails[0] : null;
  if (!top?.value) return null;

  const firstName = top?.first_name || "";
  const lastName = top?.last_name || "";
  const name = `${firstName} ${lastName}`.trim() || null;
  const email = top.value;
  const currentTitle = top?.position || null;
  const currentCompany = companyName || null;

  const proxycurlResp = await axios.get(
    "https://api.ninjapear.com/api/professionalsocmed/profile/resolve/email",
    {
      headers: {
        Authorization: `Bearer ${proxycurlApiKey}`,
      },
      params: {
        work_email: email,
      },
      timeout: 15_000,
      validateStatus: (s) => s >= 200 && s < 300,
    },
  );

  const linkedinUrl = proxycurlResp?.data?.url || null;

  return {
    name,
    email,
    linkedinUrl,
    currentTitle,
    currentCompany,
  };
}

async function enrichContact(companyDomain, companyName) {
  try {
    const pdl = await searchPdlSeniorContact(companyDomain);
    if (pdl) return pdl;
  } catch (_err) {
    // If PDL is down/misconfigured, we still want Hunter fallback.
  }

  try {
    return await enrichViaHunterAndProxycurl(companyDomain, companyName);
  } catch (_err) {
    return null;
  }
}

module.exports = {
  enrichContact,
};
