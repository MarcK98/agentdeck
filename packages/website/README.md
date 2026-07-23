# @agentdeck/website

Marketing site for AgentDeck (agentdeck.run). Pure static HTML/CSS/JS — no build
step, no dependencies, no framework. Dark "Every agent. One deck." design:
Space Grotesk + JetBrains Mono, `#0b0c1a` canvas, `#8f88ff → #59d8ff` accent.

## Pages

- `index.html` — landing: hero with a scripted ticket-lifecycle demo, feature
  rows (live threads, live map, mobile, usage ledger), how-it-works, open
  source, pricing, contact, final CTA.
- `subscribe.html` — early-access checkout. Plan picker (Hosted / Concierge)
  with a live order summary. **Payment is mocked**: the form validates and shows
  a success confirmation client-side; nothing is submitted and no card is
  charged. `?plan=concierge` preselects the Concierge tier.
- `privacy.html` — privacy policy.

## Preview locally

```sh
cd packages/website
python3 -m http.server 4600
# open http://localhost:4600
```

## Deploy

Static folder on S3 + CloudFront (see `terraform/site.tf`). Sync + invalidate:

```sh
aws s3 sync packages/website/ s3://agentdeck-run-site-772147490512/ \
  --delete --profile claude-spawn
aws cloudfront create-invalidation \
  --distribution-id E2GVVP760HF09B --paths '/*' --profile claude-spawn
```

Domain `agentdeck.run` (DNS at Namecheap). The OG image is `assets/og.png`
(1200×630) — regenerate it after visual changes by screenshotting the hero.

## Editing notes

- Layout is inline styles on the markup (a faithful port of the approved design
  build); `site.css` supplies only what inline styles can't: pseudo-classes
  (`.btn-primary`/`.btn-ghost`/`.inp` hover/focus), keyframe animations, and the
  responsive breakpoints (which override inline grids with `!important`).
- `site.js` ports the build's scroll-reveal / count-up / bar-grow effects to
  vanilla JS, fits the live-map canvas, honors `prefers-reduced-motion`, and
  drives the subscribe plan picker + mock checkout.
- Pricing lives in `index.html` under `#pricing` and is mirrored in `site.js`
  (`PLANS`) for the subscribe summary. Keep the two in sync.
