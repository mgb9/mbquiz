import { Server, routePartykitRequest, type Connection, type WSMessage } from "partyserver";
import { SESSION_MAX_AGE_MS } from "../src/session.js";
import QuizServer from "./server";

// Re-arming the cleanup alarm is a storage write, so do it at most this often.
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
    this.quiz.onMessage(msg, conn);
    this.refreshCleanupAlarm();
  }

  // A room silent for as long as a player session lasts is abandoned: wipe its
  // storage (game snapshot and PartyServer's own records). Anyone still
  // connected keeps their in-memory game, which re-persists on the next message.
  async onAlarm() {
    await this.ctx.storage.deleteAll();
  }

  // Push the cleanup alarm back. The extra ALARM_REFRESH_MS covers the throttle,
  // so the alarm never fires sooner than SESSION_MAX_AGE_MS after the last message.
  refreshCleanupAlarm() {
    const now = Date.now();
    if (now - this.alarmRefreshedAt < ALARM_REFRESH_MS) return;
    this.alarmRefreshedAt = now;
    void this.ctx.storage.setAlarm(now + SESSION_MAX_AGE_MS + ALARM_REFRESH_MS);
  }
}

// Routes /parties/main/<room> to the room's Durable Object.
export default {
  async fetch(req, env) {
    return (await routePartykitRequest(req, env)) ?? new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
