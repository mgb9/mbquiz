# Deploying WMG Quiz

The app has **two independently deployed halves** that share a wire protocol:

| Half       | What            | How it deploys                                  |
| ---------- | --------------- | ----------------------------------------------- |
| **Client** | `index.html`, `play.html`, `src/*` | GitHub Pages, automatically on every push to `main` ([.github/workflows/pages.yml](.github/workflows/pages.yml)) |
| **Server** | `party/server.ts` + `party/worker.ts` | Cloudflare Workers (PartyServer on Durable Objects), manually via `cd party && npx wrangler deploy` |

## One-time setup

```sh
cd party && npm ci
npx wrangler login   # opens a browser to authorise your Cloudflare account
```

## ⚠️ Deploy order matters

The two halves must agree on the message protocol. When a change touches both
(e.g. adding a field the server requires), **deploy the client first, then the
server.**

Why this order is safe:

- A **new client → old server** is fine: the old server simply ignores fields
  it doesn't know about.
- A **new server → old client** can break: if the server now *requires* a field
  (as the host-authorization `hostToken` does), the still-old client never sends
  it and gets rejected.

So the safe sequence for a protocol-affecting change is:

1. `git push origin main` — wait for the **Pages** action to go green
   (`gh run watch <id> --exit-status`). The new client is now live.
2. `cd party && npx wrangler deploy` — roll the server forward to match.

For server-only or client-only changes the order doesn't matter.

## Quick reference

```sh
# Deploy the server (Cloudflare Workers)
cd party && npx wrangler deploy

# Deploy the client (GitHub Pages) — just push main
git push origin main

# Run the test suite before deploying
npm test

# Local dev: server on :8787, client on :4321. Any http:// page talks to the
# local server on the same host, so phones on your Wi-Fi can use
# http://<your-mac's-IP>:4321 too. serve.json turns off serve's clean-URL
# redirect, which would drop ?room= from join links.
cd party && npx wrangler dev
npx serve -p 4321 .
```

## Configuration

- The client builds its WebSocket URL in [src/config.js](src/config.js)
  (`SERVER`, path `/parties/main/<room>`). Update it if the Worker is
  redeployed under a different name or domain.
- [party/wrangler.jsonc](party/wrangler.jsonc) declares the `Main` Durable
  Object. If you add, rename or remove a Durable Object class, add a new
  `migrations` entry there, then run `npm run types` in `party/` to regenerate
  `worker-configuration.d.ts`.
