const DEFAULT_INTEGRATION_BASE_URL = "https://tcgtracking.com/tcgapi/v1";
const DEFAULT_OPENAPI_BASE_URL = "https://openapi.tcgtracking.com/v1";

function cleanBaseUrl(url, fallback) {
  const value = String(url || fallback || "").trim();
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function cleanPath(path) {
  return String(path || "").replace(/^\/+/, "");
}

function getRequestHeaders() {
  const apiKey = String(process.env.TCGTRACKING_API_KEY || process.env.TCG_API_KEY || "").trim();
  const headers = { Accept: "application/json" };

  if (apiKey) {
    // Keep both header styles for compatibility with integration configurations.
    headers.Authorization = `Bearer ${apiKey}`;
    headers["X-API-Key"] = apiKey;
  }

  return headers;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJsonFromBase(baseUrl, path, timeoutMs) {
  const url = `${baseUrl}/${cleanPath(path)}`;
  const response = await fetchWithTimeout(
    url,
    {
      headers: getRequestHeaders(),
    },
    timeoutMs,
  );

  return { response, url };
}

export async function fetchTcgtrackingJson(path, timeoutMs = 8000) {
  const integrationBase = cleanBaseUrl(
    process.env.TCGTRACKING_INTEGRATION_BASE_URL || process.env.TCGTRACKING_BASE_URL,
    DEFAULT_INTEGRATION_BASE_URL,
  );
  const openapiBase = cleanBaseUrl(process.env.TCGTRACKING_OPENAPI_BASE_URL, DEFAULT_OPENAPI_BASE_URL);

  // Integration endpoint is the primary source by design.
  // OpenAPI remains as a resilience fallback when integration is unavailable.
  const sources = [integrationBase, openapiBase];

  let lastNon404Error = null;

  for (const base of sources) {
    try {
      const { response, url } = await fetchJsonFromBase(base, path, timeoutMs);
      if (response.ok) {
        return response.json();
      }

      if (response.status !== 404) {
        throw new Error(`TCGtracking request failed: ${response.status} ${url}`);
      }
    } catch (error) {
      const message = String(error || "");
      if (!/\b404\b/.test(message)) {
        lastNon404Error = error;
      }
    }
  }

  if (lastNon404Error) {
    throw lastNon404Error;
  }

  throw new Error(`TCGtracking request failed: 404 ${cleanPath(path)}`);
}
