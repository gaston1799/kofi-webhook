// Ko-fi webhook receiver + public donation feed for gaston1799.
//
// Endpoints:
//   POST /kofi-webhook    Ko-fi webhook destination (verification_token checked)
//   GET  /donations.json  public donation feed, CORS-enabled
//
// Persistence:
//   - GITHUB_PAT set:     donations.json is committed + pushed to the public
//                         repo configured by KOFI_DONATIONS_REPO (default
//                         gaston1799/ko-fi-donations), and the GET endpoint
//                         serves from that checkout.
//   - GITHUB_PAT unset:   donations.json is written to ./data/donations.json
//                         and a warning is logged (useful for local dev).
const express = require("express");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const PORT = Number(process.env.PORT || 3000);
const VERIFY_TOKEN = process.env.KOFI_WEBHOOK_VERIFICATION_TOKEN || "";
const GITHUB_PAT = process.env.GITHUB_PAT || "";
const DONATIONS_REPO = process.env.KOFI_DONATIONS_REPO || "gaston1799/ko-fi-donations";
const GOAL = { title: "Laptop upgrade fund", target: 370, currency: "USD" };

const PAYMENT_TYPES = new Set(["Donation", "Subscription", "Shop Order", "Commission"]);

const DATA_DIR = path.join(__dirname, "data");
const REPO_DIR = path.join(DATA_DIR, "ko-fi-donations");
const LOCAL_FILE = path.join(DATA_DIR, "donations.json");

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "100kb" }));

// ---------- persistence helpers ----------

function defaultFeed() {
  return { goal: GOAL, donations: [] };
}

function loadDonations() {
  const file = feedFile();
  if (!fs.existsSync(file)) return defaultFeed();
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!parsed || !Array.isArray(parsed.donations)) return defaultFeed();
    return parsed;
  } catch (error) {
    console.error(`[kofi-webhook] corrupt ${file}, starting from an empty feed: ${error.message}`);
    return defaultFeed();
  }
}

// Returns the path that currently holds the feed: the git checkout when we are
// in push mode, the local file otherwise.
function feedFile() {
  return fs.existsSync(path.join(REPO_DIR, ".git")) ? path.join(REPO_DIR, "donations.json") : LOCAL_FILE;
}

function tokenRemote() {
  return `https://x-access-token:${GITHUB_PAT}@github.com/${DONATIONS_REPO}.git`;
}

function sanitize(output) {
  return GITHUB_PAT ? String(output || "").split(GITHUB_PAT).join("[REDACTED]") : String(output || "");
}

function git(args, cwd, capture = true) {
  return spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
}

// Clone (or pull) the public donations repo once at startup. Never fails the
// server: on any problem we fall back to local-only persistence.
function ensureRepo() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!GITHUB_PAT) {
    if (!fs.existsSync(LOCAL_FILE)) {
      fs.writeFileSync(LOCAL_FILE, `${JSON.stringify(defaultFeed(), null, 2)}\n`);
    }
    console.warn("[kofi-webhook] GITHUB_PAT not set: donations.json will only be written locally (no git push). Set GITHUB_PAT (repo scope) to publish the feed.");
    return;
  }

  if (!fs.existsSync(REPO_DIR)) {
    const clone = git(["clone", "--depth", "1", tokenRemote(), REPO_DIR], DATA_DIR);
    if (clone.status !== 0) {
      console.error(`[kofi-webhook] clone of ${DONATIONS_REPO} failed: ${sanitize(clone.stderr || clone.stdout).trim()} — falling back to local persistence`);
      if (!fs.existsSync(LOCAL_FILE)) {
        fs.writeFileSync(LOCAL_FILE, `${JSON.stringify(defaultFeed(), null, 2)}\n`);
      }
      return;
    }
    // Remove the token from the stored remote URL so it never sits in .git/config.
    git(["remote", "set-url", "origin", `https://github.com/${DONATIONS_REPO}.git`], REPO_DIR);
    console.log(`[kofi-webhook] cloned ${DONATIONS_REPO} → ${REPO_DIR}`);
  } else {
    const pull = git(["pull", "--ff-only", "origin", "main"], REPO_DIR);
    if (pull.status !== 0) {
      console.warn(`[kofi-webhook] pull of ${DONATIONS_REPO} failed (will still try to push): ${sanitize(pull.stderr || pull.stdout).trim()}`);
    }
  }
}

// Persist the feed. In push mode: write through the git checkout, commit and
// push. Never throws for git problems — the donation stays on disk locally.
function saveDonations(feed) {
  const file = feedFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(feed, null, 2)}\n`);
  fs.renameSync(tmp, file);
  if (!GITHUB_PAT) return;

  const author = ["-c", "user.name=ko-fi-webhook", "-c", "user.email=ko-fi-webhook@users.noreply.github.com"];
  const add = git([...author, "add", "donations.json"], REPO_DIR);
  if (add.status !== 0) {
    console.error(`[kofi-webhook] git add failed: ${sanitize(add.stderr).trim()}`);
    return;
  }
  const commit = git([...author, "commit", "-m", "chore: record donation"], REPO_DIR);
  if (commit.status !== 0) {
    // Nothing staged (should not happen after an add) — keep going to the push.
    console.warn(`[kofi-webhook] git commit skipped: ${sanitize(commit.stdout || commit.stderr).trim()}`);
  }
  const push = git(["push", tokenRemote(), "HEAD:refs/heads/main"], REPO_DIR);
  if (push.status !== 0) {
    console.error(`[kofi-webhook] push to ${DONATIONS_REPO} failed (donation kept in ${file}): ${sanitize(push.stderr || push.stdout).trim()}`);
  } else {
    console.log(`[kofi-webhook] pushed donations.json → ${DONATIONS_REPO}`);
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

function donationId(data) {
  if (typeof data.kofi_transaction_id === "string" && data.kofi_transaction_id) return data.kofi_transaction_id;
  if (typeof data.transaction_id === "string" && data.transaction_id) return data.transaction_id;
  // Fallback dedupe key: (from + amount + date) per the feed spec.
  return `fallback:${(data.from_name || "anonymous").toLowerCase()}|${Number(data.amount) || 0}|${toIsoDate(data.timestamp)}`;
}

// ---------- routes ----------

app.post("/kofi-webhook", (req, res) => {
  const payload = req.body || {};
  const receivedToken = typeof payload.verification_token === "string" ? payload.verification_token : "";

  if (VERIFY_TOKEN) {
    if (!receivedToken || receivedToken !== VERIFY_TOKEN) {
      console.warn("[kofi-webhook] rejected webhook: verification token mismatch");
      return res.status(401).json({ error: "invalid verification token" });
    }
  } else {
    console.warn("[kofi-webhook] KOFI_WEBHOOK_VERIFICATION_TOKEN not set: accepting webhook without verification. Set it before going live.");
  }

  const data = payload.data && typeof payload.data === "object" ? payload.data : {};
  const type = typeof data.type === "string" ? data.type : "";

  if (!PAYMENT_TYPES.has(type)) {
    console.log(`[kofi-webhook] ignoring non-payment event: ${JSON.stringify(type) || "(no type)"}`);
    return res.status(200).json({ status: "ignored", reason: "not a payment event" });
  }

  const id = donationId(data);
  const feed = loadDonations();
  if (feed.donations.some((donation) => donation.id === id)) {
    console.log(`[kofi-webhook] duplicate event ignored: ${id}`);
    return res.status(200).json({ status: "duplicate", id });
  }

  const donation = {
    id,
    type,
    from: data.from_name || "Anonymous",
    amount: Number(data.amount) || 0,
    currency: data.currency || "USD",
    message: typeof data.message === "string" ? data.message : "",
    date: toIsoDate(data.timestamp),
    is_subscription_payment: toBool(data.is_subscription_payment),
  };

  feed.donations.push(donation);
  try {
    saveDonations(feed);
  } catch (error) {
    console.error(`[kofi-webhook] failed to persist donation: ${error.message}`);
    return res.status(500).json({ error: "persist failed" });
  }
  console.log(`[kofi-webhook] recorded ${type} from ${donation.from}: ${donation.amount} ${donation.currency} (id=${id})`);
  res.status(200).json({ status: "ok", id });
});

app.get("/donations.json", (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type");
  res.set("Cache-Control", "no-store");
  res.set("Content-Type", "application/json; charset=utf-8");
  res.send(JSON.stringify(loadDonations(), null, 2));
});

app.get("/", (req, res) => {
  res.type("text/plain").send("ko-fi-webhook: POST /kofi-webhook | GET /donations.json");
});

app.use((err, req, res, next) => {
  console.error(`[kofi-webhook] request error: ${err.message}`);
  res.status(err.status || 500).json({ error: err.type === "entity.parse.failed" ? "invalid JSON body" : "server error" });
});

// ---------- boot ----------

ensureRepo();
app.listen(PORT, () => {
  console.log(`[kofi-webhook] listening on :${PORT}`);
  console.log(`[kofi-webhook] verification token: ${VERIFY_TOKEN ? "configured" : "MISSING (dev mode)"}`);
  console.log(`[kofi-webhook] persistence: ${GITHUB_PAT ? `git push → ${DONATIONS_REPO}` : "local file only (GITHUB_PAT not set)"}`);
});
