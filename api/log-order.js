// Relais commande → Google Sheets (via Google Apps Script Web App).
// Indépendant du proxy CRM (api/submit-order.js) : le CRM n'est JAMAIS touché ici.
// Tant que GOOGLE_SHEETS_WEBHOOK_URL n'est pas configurée (Vercel) ou codée en dur
// ci-dessous, cette route est un no-op (aucune erreur, la commande part quand même au CRM).
//
// Mise en place : créer un Google Sheet + un Apps Script Web App (accès « Tout le monde »),
// puis coller son URL /exec dans SHEETS_URL_DEFAULT ci-dessous OU dans la variable
// d'environnement Vercel GOOGLE_SHEETS_WEBHOOK_URL.

const ALLOWED_ORIGIN = "https://asma-shop.vercel.app";
const MAX_BODY_BYTES = 50 * 1024; // 50 Ko

// Rate limiting en mémoire par IP (20 req/min)
const _rl = new Map();
function isRateLimited(ip) {
  const now = Date.now(), windowMs = 60_000, max = 20;
  const r = _rl.get(ip) ?? { n: 0, reset: now + windowMs };
  if (now > r.reset) { r.n = 0; r.reset = now + windowMs; }
  r.n++;
  _rl.set(ip, r);
  return r.n > max;
}

export default async function handler(req, res) {
  const isProd = process.env.NODE_ENV === "production";
  const origin = req.headers.origin ?? "";

  res.setHeader("X-Robots-Tag", "noindex");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");

  if (isProd && origin && origin !== ALLOWED_ORIGIN) {
    return res.status(403).json({ error: "Origine non autorisée" });
  }
  res.setHeader("Access-Control-Allow-Origin", isProd ? ALLOWED_ORIGIN : "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Méthode non autorisée" });

  const ip = (req.headers["x-forwarded-for"] ?? "").split(",")[0].trim()
    || req.socket?.remoteAddress || "unknown";
  if (isRateLimited(ip)) {
    res.setHeader("Retry-After", "60");
    return res.status(429).json({ error: "Trop de requêtes" });
  }

  if (Number(req.headers["content-length"] ?? 0) > MAX_BODY_BYTES) {
    return res.status(413).json({ error: "Requête trop volumineuse" });
  }

  // URL Apps Script (Web App) propre à ASMA SHOP.
  const SHEETS_URL_DEFAULT = "https://script.google.com/macros/s/AKfycbw_F8CwXeaHD8aki0FWO99aaQvT2ouqC7khMhWqLfcDjSr2UJ4JZNQHjYsha-KJ8cygfQ/exec";
  const sheetUrl = process.env.GOOGLE_SHEETS_WEBHOOK_URL || SHEETS_URL_DEFAULT;
  if (!sheetUrl) {
    return res.status(200).json({ ok: true, skipped: "Sheets non configuré" });
  }

  try {
    const r = await fetch(sheetUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...req.body, receivedAt: new Date().toISOString() }),
    });
    return res.status(r.ok ? 200 : 502).json({ ok: r.ok });
  } catch (err) {
    console.error("[log-order] Erreur Sheets:", err);
    // On renvoie 200 pour ne pas perturber le front (le log Sheets est best-effort)
    return res.status(200).json({ ok: false, error: "Sheets injoignable" });
  }
}
