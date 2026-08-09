const TOKEN_STORAGE_KEY = "vault.auth.token.v1";

function isBrowser(): boolean {
  return typeof window !== "undefined";
}

export function getStoredAuthToken(): string | null {
  if (!isBrowser()) return null;
  return window.localStorage.getItem(TOKEN_STORAGE_KEY);
}

export function setStoredAuthToken(token: string): void {
  if (!isBrowser()) return;
  window.localStorage.setItem(TOKEN_STORAGE_KEY, token);
}

export function clearStoredAuthToken(): void {
  if (!isBrowser()) return;
  window.localStorage.removeItem(TOKEN_STORAGE_KEY);
}

export function getApiBaseUrl(): string {
  const normalizeAbsolute = (raw: string): string => {
    const value = String(raw || "").trim().replace(/\/+$/, "");
    if (!value) return "";

    try {
      const parsed = new URL(value);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
      return value;
    } catch {
      return "";
    }
  };

  const cardsyncBase = normalizeAbsolute(String(import.meta.env.VITE_CARDSYNC_API_BASE_URL || ""));
  const configuredBase = normalizeAbsolute(String(import.meta.env.VITE_API_BASE_URL || ""));
  return cardsyncBase || configuredBase || "https://cardsync-api.vercel.app";
}

export function buildAuthApiUrl(path: string): string {
  const base = getApiBaseUrl();
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const relative = `/api/auth${normalizedPath}`;
  return base ? `${base}${relative}` : relative;
}
