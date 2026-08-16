// Cloudflare Workers entry — Ko-fi + GitHub Sponsors webhook receiver and
// public donation feed. Primary deploy target (free tier, no credit card).
//
// Routes:
//   POST /kofi-webhook     Ko-fi webhooks (verification_token)
//   POST /github-webhook   GitHub Sponsors webhooks (X-Hub-Signature-256)
//   GET  /donations.json   public donation feed, CORS-enabled
//   GET  /                 health/landing text
//
// Persistence: reads the feed from the public repo (raw.githubusercontent.com)
// and pushes updates back via the GitHub Contents API (GET sha → PUT base64)
// using GITHUB_PAT. Without GITHUB_PAT it falls back to the empty feed and
// logs a warning (dev mode).
//
// Env vars (set with `wrangler secret put <NAME>`):
//   KOFI_WEBHOOK_VERIFICATION_TOKEN  Ko-fi webhook token
//   GITHUB_WEBHOOK_SECRET            GitHub webhook HMAC secret
//   GITHUB_PAT                       GitHub token with Contents read/write on the donations repo
//   KOFI_DONATIONS_REPO              optional override (default gaston1799/ko-fi-donations)

const GOAL = { title: "Laptop upgrade fund", target: 370, currency: "USD" };
const PAYMENT_TYPES = new Set(["Donation", "Subscription", "Shop Order", "Commission"]);
const GITHUB_ACTIONS = new Set(["created", "tier_changed", "pending_tier_change"]);

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type, x-hub-signature-256, x-github-event, x-github-delivery",
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }
    if (request.method === "GET" && url.pathname === "/donations.json") {
      return handleGetFeed(env);
    }
    if (request.method === "POST" && url.pathname === "/kofi-webhook") {
      return handleKofi(request, env);
    }
    if (request.method === "POST" && url.pathname === "/github-webhook") {
      return handleGitHub(request, env);
    }
    if (request.method === "GET" && url.pathname === "/") {
      return json({ ok: true, endpoints: ["/kofi-webhook", "/github-webhook", "/donations.json"] }, 200);
    }
    return json({ error: "not found" }, 404);
  },
};

// ---------- helpers ----------

const repoOf = (env) => env.KOFI_DONATIONS_REPO || "gaston1799/ko-fi-donations";
const rawUrl = (env) => `https://raw.githubusercontent.com/${repoOf(env)}/main/donations.json`;
const apiUrl = (env) => `https://api.github.com/repos/${repoOf(env)}/contents/donations.json`;

const apiHeaders = (env) => ({
  accept: "application/vnd.github+json",
  "x-github-api-version": "2022-11-28",
  "user-agent": "kofi-webhook-worker/1.0",
  ...(env.GITHUB_PAT ? { authorization: `Bearer ${env.GITHUB_PAT}` } : {}),
});

const defaultFeed = () => ({ goal: GOAL, donations: [] });
const normalizeFeed = (parsed) =>
  parsed && typeof parsed === "object" && Array.isArray(parsed.donations) ? parsed : defaultFeed();

const toAmount = (value) => {
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : 0;
};

const toBool = (value) => {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return value.toLowerCase() === "true";
  if (typeof value === "number") return value !== 0;
  return Boolean(value);
};

const toIsoDate = (value) => {
  const date = new Date(value || Date.now());
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
};

const bytesToBase64 = (bytes) => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...CORS },
  });

// ---------- feed persistence (GitHub Contents API) ----------

async function readFeed(env) {
  const res = await fetch(rawUrl(env));
  if (!res.ok) throw new Error(`feed HTTP ${res.status}`);
  return normalizeFeed(await res.json());
}

async function getSha(env) {
  const res = await fetch(apiUrl(env), { headers: apiHeaders(env) });
  if (!res.ok) throw new Error(`contents GET HTTP ${res.status}`);
  const data = await res.json();
  return data && typeof data.sha === "string" ? data.sha : "";
}

async function putFeed(env, feed, sha) {
  const content = bytesToBase64(new TextEncoder().encode(`${JSON.stringify(feed, null, 2)}\n`));
  const res = await fetch(apiUrl(env), {
    method: "PUT",
    headers: { ...apiHeaders(env), "content-type": "application/json" },
    body: JSON.stringify({ message: "chore: record donation", content, sha }),
  });
  if (!res.ok) {
    throw new Error(`contents PUT HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  return res;
}

async function saveFeed(env, feed) {
  if (!env.GITHUB_PAT) {
    console.warn("[kofi-webhook] GITHUB_PAT not set: skipping push (dev mode)");
    return;
  }
  let res = await putFeed(env, feed, await getSha(env));
  if (res.status === 422) {
    // sha conflict — someone else wrote first; retry with the fresh sha.
    res = await putFeed(env, feed, await getSha(env));
  }
  if (!res.ok) {
    throw new Error(`push failed: contents PUT HTTP ${res.status}`);
  }
}

// ---------- signature verification ----------

async function verifyGitHubSignature(env, rawBody, signature) {
  if (!env.GITHUB_WEBHOOK_SECRET) return true; // dev mode
  if (typeof signature !== "string" || !signature.startsWith("sha256=")) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.GITHUB_WEBHOOK_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sigBuf = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
  const hex = [...new Uint8Array(sigBuf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const expected = `sha256=${hex}`;
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  return diff === 0;
}

// ---------- handlers ----------

async function handleKofi(request, env) {
  const payload = await request.json().catch(() => null);
  if (!payload) return json({ error: "invalid JSON body" }, 400);

  const token = typeof payload.verification_token === "string" ? payload.verification_token : "";
  if (env.KOFI_WEBHOOK_VERIFICATION_TOKEN) {
    if (!token || token !== env.KOFI_WEBHOOK_VERIFICATION_TOKEN) {
      return json({ error: "invalid verification token" }, 401);
    }
  } else {
    console.warn("[kofi-webhook] KOFI_WEBHOOK_VERIFICATION_TOKEN not set: accepting Ko-fi webhook without verification (dev mode)");
  }

  const data = payload.data && typeof payload.data === "object" ? payload.data : {};
  const type = typeof data.type === "string" ? data.type : "";
  if (!PAYMENT_TYPES.has(type)) {
    return json({ status: "ignored", reason: "not a payment event" }, 200);
  }

  const id = kofiId(data);
  const feed = await readFeed(env);
  if (feed.donations.some((donation) => donation.source === "kofi" && donation.id === id)) {
    return json({ status: "duplicate", id }, 200);
  }

  feed.donations.push({
    id,
    source: "kofi",
    type,
    from: data.from_name || "Anonymous",
    amount: toAmount(data.amount),
    currency: data.currency || "USD",
    message: typeof data.message === "string" ? data.message : "",
    date: toIsoDate(data.timestamp),
    is_subscription_payment: toBool(data.is_subscription_payment),
  });

  try {
    await saveFeed(env, feed);
  } catch (error) {
    console.error(`[kofi-webhook] persist failed: ${error.message}`);
    return json({ error: "persist failed" }, 500);
  }
  return json({ status: "ok", id }, 200);
}

function kofiId(data) {
  if (typeof data.kofi_transaction_id === "string" && data.kofi_transaction_id) {
    return data.kofi_transaction_id;
  }
  if (typeof data.transaction_id === "string" && data.transaction_id) return data.transaction_id;
  return `fallback:${(data.from_name || "anonymous").toLowerCase()}|${toAmount(data.amount)}|${toIsoDate(data.timestamp)}`;
}

async function handleGitHub(request, env) {
  const rawBody = await request.text();
  const signature = request.headers.get("x-hub-signature-256") || "";
  const delivery = request.headers.get("x-github-delivery") || "";
  const event = request.headers.get("x-github-event") || "";

  if (event !== "sponsorship") {
    return json({ status: "ignored", reason: "not a sponsorship event" }, 200);
  }
  if (!(await verifyGitHubSignature(env, rawBody, signature))) {
    console.warn(`[kofi-webhook] rejected GitHub webhook: signature mismatch (delivery ${delivery})`);
    return json({ error: "invalid signature" }, 403);
  }
  if (!env.GITHUB_WEBHOOK_SECRET) {
    console.warn("[kofi-webhook] GITHUB_WEBHOOK_SECRET not set: accepting GitHub webhook without signature verification (dev mode)");
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }

  const action = typeof payload.action === "string" ? payload.action : "";
  if (!GITHUB_ACTIONS.has(action)) {
    return json({ status: "ignored", reason: "action not processed" }, 200);
  }

  const sponsorship =
    payload.sponsorship && typeof payload.sponsorship === "object" ? payload.sponsorship : {};
  const tier = sponsorship.tier && typeof sponsorship.tier === "object" ? sponsorship.tier : {};
  const sponsor = sponsorship.sponsor && typeof sponsorship.sponsor === "object" ? sponsorship.sponsor : {};
  const nodeId = typeof sponsorship.node_id === "string" ? sponsorship.node_id : "";
  const id = nodeId ? `${nodeId}:${action}` : `github:${delivery || Date.now()}`;

  const feed = await readFeed(env);
  if (feed.donations.some((donation) => donation.source === "github" && donation.id === id)) {
    return json({ status: "duplicate", id }, 200);
  }

  const monthlyCents = toAmount(tier.monthly_price_in_cents);
  feed.donations.push({
    id,
    source: "github",
    type: "Sponsorship",
    from: typeof sponsor.login === "string" ? sponsor.login : "GitHub Sponsor",
    amount: monthlyCents / 100,
    currency: "USD",
    message: "",
    date: toIsoDate(sponsorship.created_at),
    is_subscription_payment: toBool(tier.is_one_time) ? false : true,
  });

  try {
    await saveFeed(env, feed);
  } catch (error) {
    console.error(`[kofi-webhook] persist failed: ${error.message}`);
    return json({ error: "persist failed" }, 500);
  }
  return json({ status: "ok", id }, 200);
}

async function handleGetFeed(env) {
  try {
    const feed = await readFeed(env);
    return new Response(JSON.stringify(feed, null, 2), {
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...CORS },
    });
  } catch (error) {
    console.error(`[kofi-webhook] feed read failed: ${error.message}`);
    return new Response(JSON.stringify(defaultFeed(), null, 2), {
      status: 502,
      headers: { "content-type": "application/json; charset=utf-8", ...CORS },
    });
  }
}
