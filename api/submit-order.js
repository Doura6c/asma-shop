// Proxy sécurisé — la clé API n'est jamais visible dans le navigateur.
// Vercel l'injecte depuis la variable d'environnement CRMCOD_API_KEY.

const CRMCOD_URL = "https://cod-crm-zeta.vercel.app/api/webhook/order";
const ALLOWED_ORIGIN = "https://asma-shop.vercel.app";
const MAX_BODY_BYTES = 50 * 1024; // 50 Ko

// Rate limiting en mémoire par IP (10 req/min)
const _rl = new Map();
function isRateLimited(ip) {
  const now = Date.now(), windowMs = 60_000, max = 10;
  const r = _rl.get(ip) ?? { n: 0, reset: now + windowMs };
  if (now > r.reset) { r.n = 0; r.reset = now + windowMs; }
  r.n++;
  _rl.set(ip, r);
  return r.n > max;
}

export default async function handler(req, res) {
  const isProd = process.env.NODE_ENV === "production";
  const origin = req.headers.origin ?? "";

  // Headers de sécurité sur toutes les réponses
  res.setHeader("X-Robots-Tag", "noindex");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");

  // Origin allowlist (en prod uniquement)
  if (isProd && origin !== ALLOWED_ORIGIN) {
    return res.status(403).json({ error: "Origine non autorisée" });
  }
  res.setHeader("Access-Control-Allow-Origin", isProd ? ALLOWED_ORIGIN : "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Méthode non autorisée" });

  // Rate limiting par IP
  const ip = (req.headers["x-forwarded-for"] ?? "").split(",")[0].trim()
    || req.socket?.remoteAddress
    || "unknown";
  if (isRateLimited(ip)) {
    res.setHeader("Retry-After", "60");
    return res.status(429).json({ error: "Trop de requêtes. Réessayez dans une minute." });
  }

  // Taille du payload
  if (Number(req.headers["content-length"] ?? 0) > MAX_BODY_BYTES) {
    return res.status(413).json({ error: "Requête trop volumineuse" });
  }

  const apiKey = process.env.CRMCOD_API_KEY;
  if (!apiKey) {
    console.error("[submit-order] CRMCOD_API_KEY manquante");
    return res.status(500).json({ error: "Configuration serveur invalide" });
  }

  try {
    const upstream = await fetch(CRMCOD_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Webhook-Key": apiKey, // clé ajoutée côté serveur, invisible navigateur
      },
      body: JSON.stringify(req.body),
    });
    const data = await upstream.json();
    return res.status(upstream.status).json(data);
  } catch (err) {
    console.error("[submit-order] Erreur proxy:", err);
    return res.status(502).json({ error: "Erreur de communication avec le CRM" });
  }
}
