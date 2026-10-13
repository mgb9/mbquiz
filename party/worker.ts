import { Server, routePartykitRequest, type Connection, type WSMessage } from "partyserver";
import QuizServer from "./server";

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

  onStart()                                   { return this.quiz.onStart(); }
  onConnect(conn: Connection)                 { this.quiz.onConnect(conn); }
  onClose(conn: Connection)                   { this.quiz.onClose(conn); }
  onMessage(conn: Connection, msg: WSMessage) { if (typeof msg === "string") this.quiz.onMessage(msg, conn); }
}

// Routes /parties/main/<room> to the room's Durable Object.
export default {
  async fetch(req, env) {
    return (await routePartykitRequest(req, env)) ?? new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
