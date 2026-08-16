# ko-fi-webhook

Ko-fi + GitHub Sponsors webhook receiver and public donation feed for
[gaston1799](https://github.com/gaston1799).

Receives payment webhooks from **Ko-fi** and **GitHub Sponsors**, verifies them,
deduplicates, appends each payment to `donations.json`, and publishes the feed:
a `GET /donations.json` endpoint (CORS-enabled, so any site can fetch it) plus
commits pushed to the public repo
[gaston1799/ko-fi-donations](https://github.com/gaston1799/ko-fi-donations)
via the GitHub Contents API.

## Endpoints

| Method | Path               | Description                                                        |
| ------ | ------------------ | ------------------------------------------------------------------ |
| POST   | `/kofi-webhook`    | Ko-fi webhook destination.                                         |
| POST   | `/github-webhook`  | GitHub Sponsors webhook destination (`X-Hub-Signature-256`).       |
| GET    | `/donations.json`  | Public donation feed. `Access-Control-Allow-Origin: *` enabled.    |
| GET    | `/`                | Health/landing text.                                               |

## Flow

1. **Ko-fi**: POSTs payment webhooks (types: `Donation`, `Subscription`,
   `Shop Order`, `Commission`). Verified against
   `KOFI_WEBHOOK_VERIFICATION_TOKEN`.
2. **GitHub Sponsors**: POSTs `sponsorship` events (activity types: `created`,
   `tier_changed`, `pending_tier_change`; `cancelled`/`pending_cancellation` are
   ignored). Verified against `X-Hub-Signature-256` using
   `GITHUB_WEBHOOK_SECRET`.
3. Events are deduplicated by `(source, id)` across both sources — Ko-fi uses
   the transaction id (fallback `from+amount+date`), GitHub uses
   `sponsorship node_id : action`.
4. Each payment is appended to `donations.json` with a `source` field
   (`"kofi"` or `"github"`).
5. When `GITHUB_PAT` is set the feed is pushed to
   `gaston1799/ko-fi-donations` (main branch) through the GitHub Contents API
   (GET current sha → PUT base64 content; retries once on sha conflicts).
   Without `GITHUB_PAT` the feed is written locally (`./data/donations.json`)
   and a warning is logged — webhooks never fail because of persistence issues.

## donations.json schema

```json
{
  "goal": { "title": "Laptop upgrade fund", "target": 370, "currency": "USD" },
  "donations": [
    {
      "id": "kofi_transaction_id | sponsorship_node_id:action",
      "source": "kofi | github",
      "type": "Donation | Subscription | Shop Order | Commission | Sponsorship",
      "from": "Supporter Name",
      "amount": 5,
      "currency": "USD",
      "message": "Keep up the great work!",
      "date": "2026-01-01T12:00:00.000Z",
      "is_subscription_payment": false
    }
  ]
}
```

GitHub Sponsors amounts come from `tier.monthly_price_in_cents` (USD).

## Run locally (Node/Express)

```bash
npm install
KOFI_WEBHOOK_VERIFICATION_TOKEN=your-token \
GITHUB_WEBHOOK_SECRET=your-secret \
node server.js
# without tokens (dev mode):
node server.js
```

Send a sample Ko-fi webhook:

```bash
curl -X POST http://localhost:3000/kofi-webhook \
  -H 'content-type: application/json' \
  -d '{
    "verification_token": "your-token",
    "data": {
      "type": "Donation",
      "from_name": "Test Supporter",
      "message": "First test!",
      "amount": "5.00",
      "currency": "USD",
      "is_subscription_payment": false,
      "kofi_transaction_id": "test-0001",
      "timestamp": "2026-01-01 12:00:00"
    }
  }'
```

Send a sample GitHub Sponsors webhook (signature = HMAC-SHA256 of the body with
`your-secret`, hex, prefixed `sha256=`):

```bash
BODY='{"action":"created","sponsorship":{"node_id":"MDExOlNwb25zb3JzaGlwMQ","sponsor":{"login":"octocat"},"sponsorable":{"login":"gaston1799"},"tier":{"name":"$5 a month","monthly_price_in_cents":500,"is_one_time":false},"created_at":"2026-01-01T00:00:00Z"}}'
SIG="sha256=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac 'your-secret' | awk '{print $2}')"
curl -X POST http://localhost:3000/github-webhook \
  -H "content-type: application/json" \
  -H "x-github-event: sponsorship" \
  -H "x-github-delivery: 01234567-89ab-cdef-0123-456789abcdef" \
  -H "x-hub-signature-256: $SIG" \
  --data "$BODY"
```

## Deploy — Cloudflare Workers (primary, free tier, no credit card)

```bash
npm install
npx wrangler secret put KOFI_WEBHOOK_VERIFICATION_TOKEN   # Ko-fi token
npx wrangler secret put GITHUB_WEBHOOK_SECRET             # GitHub webhook secret
npx wrangler secret put GITHUB_PAT                        # Contents r/w on the donations repo
npx wrangler deploy
```

`wrangler.toml` already sets `KOFI_DONATIONS_REPO = "gaston1799/ko-fi-donations"`.

Webhook URLs then become:

- `https://kofi-webhook.<your-subdomain>.workers.dev/kofi-webhook`
- `https://kofi-webhook.<your-subdomain>.workers.dev/github-webhook`
- Feed: `https://kofi-webhook.<your-subdomain>.workers.dev/donations.json`

## Deploy — Render (optional alternative)

`render.yaml` is included (Node, free tier, start command `node server.js`). In
the Render dashboard set these env vars:

| Variable                          | Value                                                          |
| --------------------------------- | -------------------------------------------------------------- |
| `KOFI_WEBHOOK_VERIFICATION_TOKEN` | Token from the Ko-fi webhook page                              |
| `GITHUB_WEBHOOK_SECRET`           | Secret configured in the GitHub webhook                        |
| `GITHUB_PAT`                      | PAT with `repo` scope (classic) or Contents r/w (fine-grained) |
| `KOFI_DONATIONS_REPO`             | Optional override, defaults to `gaston1799/ko-fi-donations`    |

## Webhook setup checklist

1. **Ko-fi** → https://ko-fi.com/manage/webhooks → URL
   `https://<your-service>/kofi-webhook` → copy the verification token into
   `KOFI_WEBHOOK_VERIFICATION_TOKEN`.
2. **GitHub Sponsors** → in the sponsorable repo
   (Settings → Webhooks → Add webhook):
   - Payload URL: `https://<your-service>/github-webhook`
   - Content type: `application/json`
   - Secret: anything — set it as `GITHUB_WEBHOOK_SECRET`
   - Events: **Sponsorships** (just this one)
3. Create a GitHub token with Contents read/write on `gaston1799/ko-fi-donations`
   and set it as `GITHUB_PAT`.
4. Make sure the donations repo exists and is public (`gaston1799/ko-fi-donations`).
