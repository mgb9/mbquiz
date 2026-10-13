import { Server, routePartykitRequest, type Connection, type WSMessage } from "partyserver";
import QuizServer from "./server";

// A room with no messages for this long is treated as abandoned and its saved
// game is deleted. Matches the clients' 4-hour session expiry.
const IDLE_CLEANUP_MS = 4 * 60 * 60 * 1000;
// Re-arming the alarm is a storage write, so do it at most this often.
const ALARM_REFRESH_MS = 10 * 60 * 1000;

// Durable Object hosting one quiz room. A thin adapter: all game logic lives in
// QuizServer, which stays free of Workers imports so it can be tested under Node.
// Hibernation stays off (the PartyServer default) — QuizServer keeps connection
// bookkeeping (conns, hostConnId) in memory only.
export class Main extends Server<Env> {
  quiz = new QuizServer({
    broadcast:     (msg) => this.broadcast(msg),
    getConnection: (id)  => this.getConnection(id),
    storage:       this.ctx.storage,
  });
  alarmRefreshedAt = 0;

  onStart()                                   { return this.quiz.onStart(); }
  onConnect(conn: Connection)                 { this.quiz.onConnect(conn); }
  onClose(conn: Connection)                   { this.quiz.onClose(conn); }
  onMessage(conn: Connection, msg: WSMessage) {
    if (typeof msg === "string") this.quiz.onMessage(msg, conn);
    this.refreshCleanupAlarm();
  }

  // Games abandoned before "end" would otherwise keep their `state` key forever.
  // Only that key is removed; in-memory state (if anyone is still connected) is
  // untouched and is simply re-persisted on the next message.
  async onAlarm() {
    await this.ctx.storage.delete("state");
  }

  // Push the cleanup alarm back. The extra ALARM_REFRESH_MS covers the throttle,
  // so the alarm never fires sooner than IDLE_CLEANUP_MS after the last message.
  refreshCleanupAlarm() {
    const now = Date.now();
    if (now - this.alarmRefreshedAt < ALARM_REFRESH_MS) return;
    this.alarmRefreshedAt = now;
    void this.ctx.storage.setAlarm(now + IDLE_CLEANUP_MS + ALARM_REFRESH_MS);
  }
}

// Routes /parties/main/<room> to the room's Durable Object.
export default {
  async fetch(req, env) {
    return (await routePartykitRequest(req, env)) ?? new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
