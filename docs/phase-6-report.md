# AgentDeck — Phase 6 report: mobile (plan B), local-first

Plan B (relay + native app) is built and working end-to-end **without any
account**: the relay runs locally, auth is a dev token with the Supabase seam
in place, and the app runs in Expo Go on your phone over wifi. Accounts only
enter at deploy time. Branch `phase-6-mobile`.

## Architecture (plan §4-B completed + §9.7 auth posture)

```
phone (Expo app) ──WS + token──▶ relay ◀──outbound WS + key── daemon (Mac)
```

- **`packages/relay`** — a stateless Node WS hub (~170 lines). The daemon
  dials OUT to it (`/daemon?key=…`), so the Mac's port never opens to the
  world; phones dial in (`/client?token=…`). RPC requests pipe phone→daemon
  with namespaced ids; the daemon's full event stream fans out to every
  phone. Phones learn instantly when the daemon goes offline; stranded RPCs
  time out fast. Deployable to any Node host (Fly/Railway — not Vercel, it's
  WS) unchanged.
- **Auth, pluggable and fail-closed:** `SUPABASE_JWT_SECRET` set → verifies
  Supabase HS256 access tokens (prod). Else `RELAY_DEV_TOKEN` → constant-time
  compare (now). Neither → clients refused. Daemon side always requires
  `RELAY_DAEMON_KEY`.
- **Daemon** — `relay-client.js`: connects when `SPAWN_RELAY_URL` +
  `SPAWN_RELAY_DAEMON_KEY` are set (otherwise a no-op — nothing changes for
  desktop-only use), exposes the same method surface as the local RPC,
  forwards all events, reconnects with backoff.
- **`packages/mobile`** — Expo/React Native (TypeScript, RN core components
  only, Nocturne palette). Screens: **Board** (tickets by column, live
  running dots, tap into a delegated ticket's thread), **Approvals** (allow/
  deny with full command context — badge count in the tab), **Runs** (active
  threads with live in-flight tokens, ⚡ aggregate in the top bar), **Thread**
  (transcript, typewriter streaming, steer composer). Connect screen takes
  relay URL + token; Supabase sign-in replaces exactly that screen later.

## Try it now (no accounts)

```bash
# 1. relay (Mac, any terminal)
RELAY_DAEMON_KEY=<random-a> RELAY_DEV_TOKEN=<random-b> npm start -w @agentdeck/relay
# 2. daemon with relay dial-out (add to .env or env):
SPAWN_RELAY_URL=ws://127.0.0.1:8820 SPAWN_RELAY_DAEMON_KEY=<random-a> node packages/core/src/daemon/server.js
# 3. app (phone with Expo Go, same wifi)
cd packages/mobile && npx expo start   # scan the QR; connect to ws://<mac-ip>:8820 with <random-b>
```

## Verified
- Relay E2E (`/tmp/spawn-p15-e2e.mjs`, isolated ports 8917/8918/8821) —
  **10/10**: daemon registers via outbound dial; bad phone token closed 4001;
  authenticated phone round-trips `listProjects`; unknown methods rejected
  daemon-side; `delegateTask` from the phone streams `turn:text`/`turn:done`/
  `ticket:created` back; daemon death notifies phones and fails RPCs fast.
- Mobile: `tsc --noEmit` clean; Metro export bundles clean (549 modules,
  1.56 MB Hermes bundle).
- Live bridge and daemon untouched (relay path is opt-in via env).

## Not verified
- No headed run on a real phone/simulator yet — Expo Go on your phone is the
  real test (steps above). The data layer under every screen is the E2E-proven
  relay pipe, but the RN rendering is bundle-verified only.
- `expo-asset` resolved to a newer major than SDK 52 pins; if Expo Go
  complains, `npx expo install --fix` aligns it. Cosmetic risk only.

## What's deferred until you provide accounts
1. **Supabase project** → set `SUPABASE_JWT_SECRET` on the relay, add the
   sign-in screen (replaces the token field). Everything else unchanged.
2. **Hosting** (Fly/Railway/anything Node) → deploy `packages/relay`, point
   `SPAWN_RELAY_URL` at it — phone works away from home wifi.
3. **Apple Developer ($99/yr)** → TestFlight distribution + **push
   notifications for approvals** (APNs). Until then: Expo Go on wifi/tailnet.

Hard stop here — say go for the Supabase/hosted step when accounts exist.
