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

async function enrichContact(companyDomain, companyName) {
  try {
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
  } catch (_err) {
    return null;
  }
}

module.exports = {
  enrichContact,
};
