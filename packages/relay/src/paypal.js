// AgentDeck relay — PayPal REST helpers (dependency-free; global fetch, Node 18+).
//
// Thin server-side wrappers over PayPal's Subscriptions API. We mint an app
// access token from the REST client-id/secret, look a subscription up to
// confirm it is really ACTIVE before trusting the browser's word for it, and
// verify inbound webhook signatures. Sandbox vs live is one base-URL switch.
//
// `creds` everywhere is the shape { env, clientId, secret } read from process.env
// by the caller — this module never touches the environment itself.

const LIVE = "https://api-m.paypal.com";
const SANDBOX = "https://api-m.sandbox.paypal.com";

// REST host for the configured environment ("live" → prod, anything else → sandbox).
export function paypalBase(env) {
  return env === "live" ? LIVE : SANDBOX;
}

// Mint an app access token (client_credentials grant). Throws if creds are
// missing or PayPal rejects them — callers decide how loudly to fail.
export async function getAccessToken({ env, clientId, secret }) {
  if (!clientId || !secret) throw new Error("PayPal credentials not configured");
  const auth = Buffer.from(`${clientId}:${secret}`).toString("base64");
  const res = await fetch(`${paypalBase(env)}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      authorization: `Basic ${auth}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) throw new Error(`PayPal oauth failed (${res.status})`);
  const json = await res.json();
  if (!json.access_token) throw new Error("PayPal oauth returned no token");
  return json.access_token;
}

// Look a subscription up by id → the raw PayPal subscription object (has .status,
// .plan_id, .subscriber, …). Throws on a non-2xx.
export async function getSubscription(creds, id) {
  const token = await getAccessToken(creds);
  const res = await fetch(
    `${paypalBase(creds.env)}/v1/billing/subscriptions/${encodeURIComponent(id)}`,
    { headers: { authorization: `Bearer ${token}`, "content-type": "application/json" } }
  );
  if (!res.ok) throw new Error(`PayPal subscription lookup failed (${res.status})`);
  return res.json();
}

// Verify a webhook's signature against the registered webhook id. `headers` is
// the raw incoming request header map; `body` the parsed event JSON. Returns
// true iff PayPal answers "SUCCESS".
export async function verifyWebhookSignature(creds, { webhookId, headers, body }) {
  const token = await getAccessToken(creds);
  const res = await fetch(`${paypalBase(creds.env)}/v1/notifications/verify-webhook-signature`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      auth_algo: headers["paypal-auth-algo"],
      cert_url: headers["paypal-cert-url"],
      transmission_id: headers["paypal-transmission-id"],
      transmission_sig: headers["paypal-transmission-sig"],
      transmission_time: headers["paypal-transmission-time"],
      webhook_id: webhookId,
      webhook_event: body,
    }),
  });
  if (!res.ok) return false;
  const json = await res.json();
  return json.verification_status === "SUCCESS";
}
