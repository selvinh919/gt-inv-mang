import { setCors } from "./_lib/auth.js";
import { requireAuthContext } from "./_lib/collection.js";
import { checkout, createCustomer, getSettings, listCustomers, listSales, updateSettings } from "./_lib/pos.js";

function pathParts(req) {
  const path = new URL(req.url, "http://localhost").pathname.replace(/^\/api\/pos\/?/, "");
  return path.split("/").filter(Boolean);
}

function body(req) {
  if (req.body && typeof req.body === "object") return req.body;
  try { return JSON.parse(String(req.body || "{}")); } catch { return null; }
}

export default async function handler(req, res) {
  setCors(req, res, "GET,POST,PATCH,OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  const scope = await requireAuthContext(req, res);
  if (!scope) return;
  const [resource] = pathParts(req);
  try {
    if (resource === "checkout" && req.method === "POST") return res.status(201).json(await checkout(scope, body(req)));
    if (resource === "sales" && req.method === "GET") return res.status(200).json(await listSales(scope));
    if (resource === "customers" && req.method === "GET") return res.status(200).json(await listCustomers(scope));
    if (resource === "customers" && req.method === "POST") return res.status(201).json(await createCustomer(scope, body(req)));
    if (resource === "settings" && req.method === "GET") return res.status(200).json(await getSettings(scope));
    if (resource === "settings" && req.method === "PATCH") return res.status(200).json(await updateSettings(scope, body(req)));
    return res.status(404).json({ error: "Not found" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "POS request failed";
    const status = /required|valid|stock|available|not found|between/i.test(message) ? 400 : /role/i.test(message) ? 403 : 500;
    return res.status(status).json({ error: message });
  }
}
