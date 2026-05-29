# Deploying WMG Quiz

The app has **two independently deployed halves** that share a wire protocol:

| Half       | What            | How it deploys                                  |
| ---------- | --------------- | ----------------------------------------------- |
| **Client** | `index.html`, `play.html`, `src/*` | GitHub Pages, automatically on every push to `main` ([.github/workflows/pages.yml](.github/workflows/pages.yml)) |
| **Server** | `party/server.ts` | PartyKit, manually via `cd party && npx partykit deploy` |

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
2. `cd party && npx partykit deploy` — roll the server forward to match.

For server-only or client-only changes the order doesn't matter.

## Quick reference

```sh
# Deploy the server (PartyKit)
cd party && npx partykit deploy

# Deploy the client (GitHub Pages) — just push main
git push origin main

# Run the test suite before deploying
npm test
```

## Configuration

The client points at the deployed PartyKit host in
[src/config.js](src/config.js) (`PARTYKIT_HOST`). Update it if you redeploy the
server under a different name.
