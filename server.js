// Ko-fi + GitHub Sponsors webhook receiver and public donation feed.
//
// Endpoints:
//   POST /kofi-webhook     Ko-fi webhooks (verification_token)
//   POST /github-webhook   GitHub Sponsors webhooks (X-Hub-Signature-256)
//   GET  /donations.json   public donation feed, CORS-enabled
//
// Persistence (GitHub Contents API, no git binary needed):
//   - GITHUB_PAT set:  donations.json is read from / pushed to the public repo
//                      configured by KOFI_DONATIONS_REPO (default
//                      gaston1799/ko-fi-donations) via the GitHub Contents API
//                      (GET for the sha, PUT with base64 content).
//   - GITHUB_PAT unset: donations.json is written to ./data/donations.json
//                      and a warning is logged (local dev mode).
const express = require("express");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const PORT = Number(process.env.PORT || 3000);
const VERIFY_TOKEN = process.env.KOFI_WEBHOOK_VERIFICATION_TOKEN || "";
const GITHUB_SECRET = process.env.GITHUB_WEBHOOK_SECRET || "";
const GITHUB_PAT = process.env.GITHUB_PAT || "";
const DONATIONS_REPO = process.env.KOFI_DONATIONS_REPO || "gaston1799/ko-fi-donations";
const GOAL = { title: "Laptop upgrade fund", target: 370, currency: "USD" };

const PAYMENT_TYPES = new Set(["Donation", "Subscription", "Shop Order", "Commission"]);
const GITHUB_ACTIONS = new Set(["created", "tier_changed", "pending_tier_change"]);

const DATA_DIR = path.join(__dirname, "data");
const LOCAL_FILE = path.join(DATA_DIR, "donations.json");

// In-memory mirror of the feed, refreshed on boot/webhooks and used by GET.
let cache = null;

const app = express();
app.disable("x-powered-by");
app.use(
  express.json({
    limit: "200kb",
    verify: (req, res, buf) => {
      req.rawBody = buf; // needed for GitHub's HMAC signature check
    },
  }),
);

// ---------- feed helpers ----------

function defaultFeed() {
  return { goal: GOAL, donations: [] };
}

function normalizeFeed(parsed) {
  return parsed && typeof parsed === "object" && Array.isArray(parsed.donations)
    ? parsed
    : defaultFeed();
}

function readLocalFile() {
  try {
    if (!fs.existsSync(LOCAL_FILE)) return null;
    return normalizeFeed(JSON.parse(fs.readFileSync(LOCAL_FILE, "utf8")));
  } catch {
    return null;
  }
}

function writeLocalFile(feed) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${LOCAL_FILE}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(feed, null, 2)}\n`);
  fs.renameSync(tmp, LOCAL_FILE);
}

async function readRemoteFeed() {
  const res = await fetch(
    `https://raw.githubusercontent.com/${DONATIONS_REPO}/main/donations.json`,
    { headers: { "user-agent": "kofi-webhook/1.1" } },
  );
  if (!res.ok) throw new Error(`raw feed HTTP ${res.status}`);
  return normalizeFeed(await res.json());
}

async function loadFeed() {
  if (cache) return cache;
  if (GITHUB_PAT) {
    try {
      cache = await readRemoteFeed();
      return cache;
    } catch (error) {
      console.warn(`[webhook] could not read remote feed (${error.message}); using local mirror`);
    }
  }
  cache = readLocalFile() || defaultFeed();
  return cache;
}

// ---------- GitHub Contents API ----------

function apiUrl() {
  return `https://api.github.com/repos/${DONATIONS_REPO}/contents/donations.json`;
}

function apiHeaders() {
  const headers = {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "kofi-webhook/1.1",
  };
  if (GITHUB_PAT) headers.authorization = `Bearer ${GITHUB_PAT}`;
  return headers;
}

async function getFileSha() {
  const res = await fetch(apiUrl(), { headers: apiHeaders() });
  if (!res.ok) throw new Error(`contents GET HTTP ${res.status}`);
  const data = await res.json();
  return typeof data.sha === "string" ? data.sha : "";
}

async function putFile(feed, sha) {
  const content = Buffer.from(`${JSON.stringify(feed, null, 2)}\n`, "utf8").toString("base64");
  const res = await fetch(apiUrl(), {
    method: "PUT",
    headers: { ...apiHeaders(), "content-type": "application/json" },
    body: JSON.stringify({ message: "chore: record donation", content, sha }),
  });
  if (!res.ok) {
    throw new Error(`contents PUT HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  return res.json();
}

// Persist the feed: always keep a local mirror; when GITHUB_PAT is set, push to
// the repo via the Contents API (retry once on a 422 sha conflict).
async function saveFeed(feed) {
  cache = feed;
  writeLocalFile(feed);
  if (!GITHUB_PAT) return;
  try {
    await putFile(feed, await getFileSha());
  } catch (error) {
    if (/422/.test(error.message)) {
      try {
        await putFile(feed, await getFileSha());
        return;
      } catch (retryError) {
        console.error(`[webhook] push retry failed (feed kept locally): ${retryError.message}`);
        return;
      }
    }
    console.error(`[webhook] push to ${DONATIONS_REPO} failed (feed kept locally): ${error.message}`);
  }
}

// ---------- payload helpers ----------

function toBool(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return value.toLowerCase() === "true";
  if (typeof value === "number") return value !== 0;
  return Boolean(value);
}

function toIsoDate(value) {
  const date = new Date(value || Date.now());
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

function toAmount(value) {
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : 0;
}

function kofiId(data) {
  if (typeof data.kofi_transaction_id === "string" && data.kofi_transaction_id) {
    return data.kofi_transaction_id;
  }
  if (typeof data.transaction_id === "string" && data.transaction_id) return data.transaction_id;
  // Fallback dedupe key: (from + amount + date).
  return `fallback:${(data.from_name || "anonymous").toLowerCase()}|${toAmount(data.amount)}|${toIsoDate(data.timestamp)}`;
}

function verifyGitHubSignature(rawBody, signature) {
  if (!GITHUB_SECRET) return true; // dev mode: caller logs the warning
  if (typeof signature !== "string" || !signature.startsWith("sha256=")) return false;
  const expected =
    "sha256=" + crypto.createHmac("sha256", GITHUB_SECRET).update(rawBody).digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signature, "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---------- routes ----------

app.post("/kofi-webhook", async (req, res) => {
  const payload = req.body || {};
  const receivedToken =
    typeof payload.verification_token === "string" ? payload.verification_token : "";

  if (VERIFY_TOKEN) {
    if (!receivedToken || receivedToken !== VERIFY_TOKEN) {
      console.warn("[webhook] rejected Ko-fi webhook: verification token mismatch");
      return res.status(401).json({ error: "invalid verification token" });
    }
  } else {
    console.warn("[webhook] KOFI_WEBHOOK_VERIFICATION_TOKEN not set: accepting Ko-fi webhook without verification. Set it before going live.");
  }

  const data = payload.data && typeof payload.data === "object" ? payload.data : {};
  const type = typeof data.type === "string" ? data.type : "";

  if (!PAYMENT_TYPES.has(type)) {
    console.log(`[webhook] ignoring non-payment Ko-fi event: ${JSON.stringify(type) || "(no type)"}`);
    return res.status(200).json({ status: "ignored", reason: "not a payment event" });
  }

  const id = kofiId(data);
  const feed = await loadFeed();
  if (feed.donations.some((donation) => donation.source === "kofi" && donation.id === id)) {
    console.log(`[webhook] duplicate Ko-fi event ignored: ${id}`);
    return res.status(200).json({ status: "duplicate", id });
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
    await saveFeed(feed);
  } catch (error) {
    console.error(`[webhook] failed to persist donation: ${error.message}`);
    return res.status(500).json({ error: "persist failed" });
  }
  console.log(`[webhook] recorded Ko-fi ${type} from ${data.from_name || "Anonymous"}: ${data.amount || 0} ${data.currency || "USD"} (id=${id})`);
  res.status(200).json({ status: "ok", id });
});

app.post("/github-webhook", async (req, res) => {
  const rawBody = req.rawBody || Buffer.alloc(0);
  const signature = req.get("x-hub-signature-256") || "";
  const delivery = req.get("x-github-delivery") || "";
  const event = req.get("x-github-event") || "";

  if (event !== "sponsorship") {
    console.log(`[webhook] ignoring GitHub event: ${JSON.stringify(event) || "(none)"}`);
    return res.status(200).json({ status: "ignored", reason: "not a sponsorship event" });
  }
  if (!verifyGitHubSignature(rawBody, signature)) {
    console.warn(`[webhook] rejected GitHub webhook: signature mismatch (delivery ${delivery})`);
    return res.status(403).json({ error: "invalid signature" });
  }
  if (!GITHUB_SECRET) {
    console.warn("[webhook] GITHUB_WEBHOOK_SECRET not set: accepting GitHub webhook without signature verification. Set it before going live.");
  }

  const payload = req.body || {};
  const action = typeof payload.action === "string" ? payload.action : "";
  if (!GITHUB_ACTIONS.has(action)) {
    console.log(`[webhook] ignoring GitHub sponsorship action: ${JSON.stringify(action) || "(none)"}`);
    return res.status(200).json({ status: "ignored", reason: "action not processed" });
  }

  const sponsorship =
    payload.sponsorship && typeof payload.sponsorship === "object" ? payload.sponsorship : {};
  const tier = sponsorship.tier && typeof sponsorship.tier === "object" ? sponsorship.tier : {};
  const sponsor = sponsorship.sponsor && typeof sponsorship.sponsor === "object" ? sponsorship.sponsor : {};
  const nodeId = typeof sponsorship.node_id === "string" ? sponsorship.node_id : "";
  // One entry per meaningful sponsorship action; dedupe key includes the action.
  const id = nodeId ? `${nodeId}:${action}` : `github:${delivery || Date.now()}`;

  const feed = await loadFeed();
  if (feed.donations.some((donation) => donation.source === "github" && donation.id === id)) {
    console.log(`[webhook] duplicate GitHub sponsorship ignored: ${id}`);
    return res.status(200).json({ status: "duplicate", id });
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
    await saveFeed(feed);
  } catch (error) {
    console.error(`[webhook] failed to persist donation: ${error.message}`);
    return res.status(500).json({ error: "persist failed" });
  }
  console.log(`[webhook] recorded GitHub sponsorship ${action} from ${sponsor.login || "unknown"}: $${(monthlyCents / 100).toFixed(2)}/mo (id=${id})`);
  res.status(200).json({ status: "ok", id });
});

app.get("/donations.json", async (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, X-Hub-Signature-256, X-GitHub-Event, X-GitHub-Delivery");
  res.set("Cache-Control", "no-store");
  res.set("Content-Type", "application/json; charset=utf-8");
  try {
    res.send(JSON.stringify(await loadFeed(), null, 2));
  } catch (error) {
    console.error(`[webhook] feed read failed: ${error.message}`);
    res.status(502).send(JSON.stringify(defaultFeed(), null, 2));
  }
});

app.get("/", (req, res) => {
  res.type("text/plain").send("ko-fi-webhook: POST /kofi-webhook | POST /github-webhook | GET /donations.json");
});

app.use((err, req, res, next) => {
  console.error(`[webhook] request error: ${err.message}`);
  res.status(err.status || 500).json({ error: err.type === "entity.parse.failed" ? "invalid JSON body" : "server error" });
});

// ---------- boot ----------

(async () => {
  if (GITHUB_PAT) {
    try {
      cache = await readRemoteFeed();
      console.log(`[webhook] feed loaded from ${DONATIONS_REPO}`);
    } catch (error) {
      console.warn(`[webhook] initial remote feed load failed (${error.message}); will fall back to local mirror`);
    }
  } else {
    cache = readLocalFile() || defaultFeed();
  }

  app.listen(PORT, () => {
    console.log(`[webhook] listening on :${PORT}`);
    console.log(`[webhook] Ko-fi verification token: ${VERIFY_TOKEN ? "configured" : "MISSING (dev mode)"}`);
    console.log(`[webhook] GitHub webhook secret: ${GITHUB_SECRET ? "configured" : "MISSING (dev mode)"}`);
    console.log(`[webhook] persistence: ${GITHUB_PAT ? `Contents API → ${DONATIONS_REPO}` : "local file only (GITHUB_PAT not set)"}`);
  });
})();
