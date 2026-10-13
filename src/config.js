// Quiz server: a Cloudflare Worker + Durable Object (PartyServer), deployed with
// `cd party && npx wrangler deploy`. Pages served from localhost talk to
// `wrangler dev` instead, so local testing never touches the live server.
const LOCAL = typeof location !== "undefined" && ["localhost", "127.0.0.1"].includes(location.hostname);
const SERVER_HOST = LOCAL ? "localhost:8787" : "wmg-quiz.SUBDOMAIN.workers.dev"; // TODO: set after first deploy

// WebSocket URL for a room. PartyServer routes /parties/<binding>/<room>.
export const roomSocketUrl = (room) =>
  `${LOCAL ? "ws" : "wss"}://${SERVER_HOST}/parties/main/${encodeURIComponent(room)}`;
