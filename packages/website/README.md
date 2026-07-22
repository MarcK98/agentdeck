# @spawn/website

Marketing site for Spawn (spawnmy.ai). Pure static HTML/CSS/JS — no build
step, no dependencies, styled with the Nocturne tokens from
`packages/desktop/src/nocturne.css`.

## Preview locally

```sh
cd packages/website
python3 -m http.server 4600
# open http://localhost:4600
```

## Deploy

It's a static folder — point any static host at `packages/website/`:

- **Cloudflare Pages / Netlify / Vercel**: root directory `packages/website`,
  no build command, output `.`.
- **GitHub Pages**: publish this folder from a workflow or a `gh-pages` branch.

Domain: `spawnmy.ai`. The OG image is referenced at `assets/og.png`
(1200×630) — regenerate it after visual changes by screenshotting the hero.

## Editing notes

- Pricing tiers live in `index.html` under `#pricing`; numbers are drafts
  until payments exist. CTAs are `mailto:hello@spawnmy.ai` until then.
- Colors/typography come from Nocturne — if the desktop theme retunes,
  mirror the token values at the top of `site.css`.
