# PayPal subscriptions — go-live guide

The AgentDeck subscribe page (`subscribe.html`) takes **real PayPal
subscriptions**. The browser talks to PayPal directly with the PayPal JS SDK;
the **relay** (`packages/relay`) exposes three billing endpoints that keep the
secret server-side, re-verify each subscription, and log events:

| Endpoint | Method | Purpose |
| --- | --- | --- |
| `/billing/config` | GET | Public config the SDK needs: `clientId`, plan ids, `env`. Never the secret. |
| `/billing/activate` | POST | Browser posts the approved `subscriptionID`; relay re-verifies it via PayPal REST, then logs it. |
| `/billing/webhook` | POST | PayPal's server-to-server events (activated / cancelled / expired / payment). Signature-verified, then logged. |

Nothing is charged until you complete every step below. Until `PAYPAL_CLIENT_ID`
is set, the page shows a friendly "Payments are being configured" state instead
of broken buttons — safe to ship early.

---

## 1. PayPal Business account

1. Go to <https://www.paypal.com/bizsignup> and create (or upgrade to) a
   **Business** account. Personal accounts can't create subscription plans.
2. Confirm your email and add a payout bank account so you can withdraw revenue.

## 2. Create a REST app (get client-id + secret)

1. Open the **PayPal Developer Dashboard**: <https://developer.paypal.com/dashboard/applications/>.
2. There are two tabs: **Sandbox** (fake money, for testing) and **Live** (real
   money). Do the whole flow in **Sandbox** first, then repeat for **Live**.
3. Click **Create App**, name it `AgentDeck`, create it.
4. Copy the **Client ID** and **Secret**. These map to:
   - `PAYPAL_CLIENT_ID`
   - `PAYPAL_SECRET`
5. Set `PAYPAL_ENV=sandbox` while testing; flip to `PAYPAL_ENV=live` for
   production and swap in the **Live** app's keys (they are different values).

> Sandbox test buyers: Developer Dashboard → **Testing Tools → Sandbox Accounts**
> gives you a fake buyer email + password to complete a sandbox checkout.

## 3. Create the two monthly subscription Plans

Each plan needs a **Product** first, then a **Plan** with a monthly billing
cycle. You can do this in the dashboard (**Pay & Get Paid → Subscriptions →
Products / Plans**) or via the API (appendix below — faster + repeatable).

Create two plans:

| Plan | Price | Env var |
| --- | --- | --- |
| Hosted | **$20.00 / month** | `PAYPAL_PLAN_HOSTED` |
| Concierge | **$100.00 / month** | `PAYPAL_PLAN_CONCIERGE` |

Copy each plan id (looks like `P-1AB23456CD789012EF34GHIJ`) into the matching
env var. Sandbox and Live plan ids are distinct — create the pair in each env.

## 4. Register the webhook

1. Developer Dashboard → your app → **Webhooks** → **Add Webhook**.
2. Webhook URL: `https://<your-relay-host>/billing/webhook`
   (e.g. `https://spawn-relay.duckdns.org/billing/webhook`).
3. Subscribe to at least these event types:
   - `BILLING.SUBSCRIPTION.ACTIVATED`
   - `BILLING.SUBSCRIPTION.CANCELLED`
   - `BILLING.SUBSCRIPTION.EXPIRED`
   - `PAYMENT.SALE.COMPLETED`
4. Save, then copy the generated **Webhook ID** into `PAYPAL_WEBHOOK_ID`.
   Without it the relay still returns 200 but logs events **unverified** — set it
   before going live so forged webhooks are rejected.

## 5. Set the relay env vars

Set these where the relay runs (see `.env.example` → "PayPal billing (relay)"):

```
PAYPAL_ENV=live                 # or "sandbox" while testing
PAYPAL_CLIENT_ID=...            # from step 2 (matching env)
PAYPAL_SECRET=...               # from step 2 (matching env) — server only
PAYPAL_PLAN_HOSTED=P-...        # $20/mo plan id
PAYPAL_PLAN_CONCIERGE=P-...     # $100/mo plan id
PAYPAL_WEBHOOK_ID=...           # from step 4
BILLING_LOG=./subscriptions.jsonl   # optional; where records are appended
```

Restart the relay. Sanity checks:

```bash
curl https://<relay>/billing/config
# → {"clientId":"...","plans":{"hosted":"P-...","concierge":"P-..."},"env":"live"}
```

Then open `subscribe.html`, pick a plan, enter an email — the PayPal buttons
should render. Complete a sandbox checkout and confirm a line lands in
`subscriptions.jsonl`. The website reads the relay base from `RELAY_BASE` in
`site.js` (default `https://spawn-relay.duckdns.org`); override at runtime by
setting `window.RELAY_BASE` before `site.js` loads.

---

## Appendix — create plans via the API

Handy if you'd rather not click through the dashboard. `$BASE` is
`https://api-m.sandbox.paypal.com` (sandbox) or `https://api-m.paypal.com` (live).

```bash
# 0. Credentials from your REST app
CLIENT_ID="your-client-id"
SECRET="your-secret"
BASE="https://api-m.sandbox.paypal.com"

# 1. Get an access token
TOKEN=$(curl -s "$BASE/v1/oauth2/token" \
  -u "$CLIENT_ID:$SECRET" \
  -d "grant_type=client_credentials" | python3 -c 'import sys,json;print(json.load(sys.stdin)["access_token"])')

# 2. Create a product (do this once; reuse its id for both plans)
PRODUCT_ID=$(curl -s "$BASE/v1/catalogs/products" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{
    "name": "AgentDeck",
    "description": "Managed AgentDeck hosting",
    "type": "SERVICE",
    "category": "SOFTWARE"
  }' | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')

# 3. Create the Hosted plan ($20/mo)
curl -s "$BASE/v1/billing/plans" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{
    "product_id": "'"$PRODUCT_ID"'",
    "name": "AgentDeck Hosted",
    "status": "ACTIVE",
    "billing_cycles": [{
      "frequency": { "interval_unit": "MONTH", "interval_count": 1 },
      "tenure_type": "REGULAR",
      "sequence": 1,
      "total_cycles": 0,
      "pricing_scheme": { "fixed_price": { "value": "20", "currency_code": "USD" } }
    }],
    "payment_preferences": {
      "auto_bill_outstanding": true,
      "setup_fee_failure_action": "CONTINUE",
      "payment_failure_threshold": 1
    }
  }'
# → response "id" is your PAYPAL_PLAN_HOSTED

# 4. Create the Concierge plan ($100/mo) — same call with value "100" and name "AgentDeck Concierge"
```

Copy each returned plan `id` into `PAYPAL_PLAN_HOSTED` / `PAYPAL_PLAN_CONCIERGE`.
