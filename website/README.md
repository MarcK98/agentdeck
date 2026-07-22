# Spawn website

Static marketing site for spawnmy.ai. No build step, no dependencies.

- `index.html` — single page: hero, features, architecture, open source, pricing, FAQ.
- `styles.css` — Nocturne design language (tokens mirror `packages/desktop/src/nocturne.css`).

## Preview

```sh
open website/index.html
# or
npx serve website
```

## Deploy

Any static host. Point spawnmy.ai at the `website/` directory:

- **Cloudflare Pages / Vercel / Netlify** — root dir `website`, no build command, output `.`
- **GitHub Pages** — serve `website/` from a workflow or move contents to a `gh-pages` branch.
