// Quiz server (Cloudflare Worker + Durable Object, see DEPLOY.md). The live
// site is always https; any http:// page is a local copy, so it talks to
// `wrangler dev` on the same host and never touches the live server.
const LOCAL = location.protocol === "http:";
const SERVER = LOCAL ? `ws://${location.hostname}:8787` : "wss://wmg-quiz.mark-b12.workers.dev";

// WebSocket URL for a room. PartyServer routes /parties/<binding>/<room>.
export const roomSocketUrl = (room) => `${SERVER}/parties/main/${encodeURIComponent(room)}`;
