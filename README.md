# ko-fi-webhook

Ko-fi webhook receiver + public donation feed for [gaston1799](https://github.com/gaston1799).

A tiny Node/Express app that receives Ko-fi payment webhooks, verifies them,
appends each payment to `donations.json`, and publishes the feed — both as a
`GET /donations.json` endpoint (CORS-enabled, so any site can fetch it) and as
commits to the public repo [gaston1799/ko-fi-donations](https://github.com/gaston1799/ko-fi-donations).

## Endpoints

| Method | Path             | Description                                                        |
| ------ | ---------------- | ------------------------------------------------------------------ |
| POST   | `/kofi-webhook`  | Ko-fi webhook destination (configured in Ko-fi → Webhooks).        |
| GET    | `/donations.json`| Public donation feed. `Access-Control-Allow-Origin: *` enabled.    |
| GET    | `/`              | Health/landing text.                                               |

## Flow

1. Ko-fi POSTs a payment webhook (types: `Donation`, `Subscription`,
   `Shop Order`, `Commission`).
2. The server checks `verification_token` against
   `KOFI_WEBHOOK_VERIFICATION_TOKEN` (if the env var is unset it logs a warning
   and accepts the request — dev mode only).
3. The event is deduplicated by transaction id (`kofi_transaction_id`, falling
   back to `from + amount + date`).
4. The donation is appended to `donations.json` and, when `GITHUB_PAT` is set,
   committed + pushed to `gaston1799/ko-fi-donations` (main branch).
5. Without `GITHUB_PAT` the file is still written locally (`./data/donations.json`)
   and a warning is logged — the webhook never fails because of git problems.

## donations.json schema

```json
{
  "goal": { "title": "Laptop upgrade fund", "target": 370, "currency": "USD" },
  "donations": [
    {
      "id": "kofi_transaction_id",
      "type": "Donation",
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

## Run locally

```bash
npm install
KOFI_WEBHOOK_VERIFICATION_TOKEN=your-token node server.js
# without a token (dev mode):
node server.js
```

Send a sample webhook:

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

## Deploy to Render

`render.yaml` is included (Node, free tier, start command `node server.js`).
In the Render dashboard set these env vars:

| Variable                          | Value                                                          |
| --------------------------------- | -------------------------------------------------------------- |
| `KOFI_WEBHOOK_VERIFICATION_TOKEN` | Token shown on the Ko-fi webhook page                          |
| `GITHUB_PAT`                      | PAT with `repo` scope (classic) or Contents r/w on the donations repo (fine-grained) |
| `KOFI_DONATIONS_REPO`             | Optional override, defaults to `gaston1799/ko-fi-donations`    |

Then in Ko-fi → Webhooks set the URL to
`https://<your-service>.onrender.com/kofi-webhook` and copy the verification
token into the env var above.

## Setup checklist

1. Create a GitHub PAT at https://github.com/settings/tokens with `repo` scope,
   set it as `GITHUB_PAT`.
2. Make sure the donations repo exists and is public
   (`gaston1799/ko-fi-donations` by default; create with
   `gh repo create gaston1799/ko-fi-donations --public`).
3. Set `KOFI_WEBHOOK_VERIFICATION_TOKEN` from Ko-fi → Webhooks.
4. Point the Ko-fi webhook URL at `/kofi-webhook`.
