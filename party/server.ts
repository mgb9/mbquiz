import type * as Party from "partykit/server";
import { scoreAnswer } from "../src/scoring.js";
import { validateQuestions } from "../src/validation.js";

// ── Types ─────────────────────────────────────────────────────────────────────

interface Player {
  name: string;
  score: number;
  joinedAt: number;
  token: string;
  answers: Record<number, number>; // questionIndex → chosen answer index
}

interface Answer {
  answerIndex: number;
  answeredAt: number; // server ms timestamp — never trust the client
}

interface Question {
  q: string;
  answers: string[];
  correct: number;
  time?: number; // per-question override
}

type Phase = "lobby" | "question" | "reveal" | "leaderboard" | "end";

// ── Wire protocol ───────────────────────────────────────────────────────────
// Inbound messages from clients. Typed as a discriminated union so each handler
// gets a narrowed shape and the client/server contract can't silently drift.

interface JoinMsg       { type: "join";        nickname?: unknown; token?: unknown; }
interface RejoinMsg     { type: "rejoin";      nickname?: unknown; token?: unknown; }
interface StartMsg      { type: "start";       hostToken?: unknown; questions?: unknown; title?: unknown; defaultTime?: unknown; flatScoring?: unknown; }
interface BeginTimerMsg { type: "begin_timer"; hostToken?: unknown; }
interface AnswerMsg     { type: "answer";      answerIndex?: unknown; }
interface NextMsg       { type: "next";        hostToken?: unknown; }
interface EndMsg        { type: "end";         hostToken?: unknown; }

type ClientMessage =
  | JoinMsg | RejoinMsg | StartMsg | BeginTimerMsg | AnswerMsg | NextMsg | EndMsg;

// Messages that drive the game forward — only the host may send them.
type HostMessage = StartMsg | BeginTimerMsg | NextMsg | EndMsg;

// ── Persistence ─────────────────────────────────────────────────────────────
// Snapshot shape written to room storage. `conns` is intentionally excluded —
// connection IDs are meaningless after a restart; clients re-register on reconnect.

interface Snapshot {
  players:           [string, Player][];
  questions:         Question[];
  quizTitle:         string;
  defaultTime:       number;
  flatScoring:       boolean;
  phase:             Phase;
  currentQ:          number;
  questionStartTime: number;
  timerStarted:      boolean;
  answers:           [string, Answer][];
  hostToken:         string;
}

// ── Server ────────────────────────────────────────────────────────────────────

export default class QuizServer implements Party.Server {
  // Keyed by nickname so it survives connection drops / reconnects.
  players = new Map<string, Player>();
  // connectionId → nickname — populated on join/rejoin, cleared on close.
  conns   = new Map<string, string>();

  questions:        Question[] = [];
  quizTitle:        string  = "";
  defaultTime:      number  = 30;
  flatScoring:      boolean = false;
  phase:            Phase   = "lobby";
  currentQ:         number  = -1;
  questionStartTime:number  = 0;
  timerStarted:     boolean = false;
  answers = new Map<string, Answer>(); // nickname → Answer

  // Secret minted by the host client at game creation. The first `start` claims
  // it; thereafter only messages carrying the matching token may drive the game.
  hostToken:        string  = "";

  constructor(readonly room: Party.Room) {}

  // ── Persistence ───────────────────────────────────────────────────────────

  // Rehydrate an in-progress game after a room restart / eviction.
  async onStart() {
    const snap = await this.room.storage.get<Snapshot>("state");
    if (!snap) return;
    this.players           = new Map(snap.players);
    this.questions         = snap.questions;
    this.quizTitle         = snap.quizTitle;
    this.defaultTime       = snap.defaultTime;
    this.flatScoring       = snap.flatScoring;
    this.phase             = snap.phase;
    this.currentQ          = snap.currentQ;
    this.questionStartTime = snap.questionStartTime;
    this.timerStarted      = snap.timerStarted;
    this.answers           = new Map(snap.answers);
    this.hostToken         = snap.hostToken;
  }

  // Fire-and-forget snapshot; callers don't await so broadcasts stay snappy.
  persist() {
    if (this.phase === "end") {
      void this.room.storage.delete("state");
      return;
    }
    const snap: Snapshot = {
      players:           Array.from(this.players.entries()),
      questions:         this.questions,
      quizTitle:         this.quizTitle,
      defaultTime:       this.defaultTime,
      flatScoring:       this.flatScoring,
      phase:             this.phase,
      currentQ:          this.currentQ,
      questionStartTime: this.questionStartTime,
      timerStarted:      this.timerStarted,
      answers:           Array.from(this.answers.entries()),
      hostToken:         this.hostToken,
    };
    void this.room.storage.put("state", snap);
  }

  // ── Connection lifecycle ─────────────────────────────────────────────────

  onConnect(conn: Party.Connection) {
    // If a host connects (or reconnects) during the lobby, immediately send
    // the current player list so the count is never stale after a reconnect.
    if (this.phase === "lobby") {
      conn.send(JSON.stringify({
        type:    "player_list",
        players: Array.from(this.players.values()).map(p => ({ name: p.name })),
        count:   this.players.size,
      }));
    }
  }

  onClose(conn: Party.Connection) {
    this.conns.delete(conn.id);
  }

  // ── Message routing ──────────────────────────────────────────────────────

  onMessage(raw: string, sender: Party.Connection) {
    let msg: ClientMessage;
    try { msg = JSON.parse(raw) as ClientMessage; } catch { return; }
    if (!msg || typeof msg.type !== "string") return;

    // Gate game-control messages behind host authorization.
    if (this.isHostMessage(msg) && !this.authorizeHost(msg, sender)) return;

    switch (msg.type) {
      case "join":        this.handleJoin(msg, sender);        break;
      case "rejoin":      this.handleRejoin(msg, sender);      break;
      case "start":       this.handleStart(msg, sender);       break;
      case "begin_timer": this.handleBeginTimer(sender);       break;
      case "answer":      this.handleAnswer(msg, sender);      break;
      case "next":        this.handleNext(sender);             break;
      case "end":         this.handleEnd();                    break;
    }
  }

  // ── Authorization ──────────────────────────────────────────────────────────

  isHostMessage(msg: ClientMessage): msg is HostMessage {
    return msg.type === "start" || msg.type === "begin_timer"
        || msg.type === "next"  || msg.type === "end";
  }

  /**
   * Returns true if this control message may proceed. The first `start` claims
   * the room's hostToken; from then on every control message must present it.
   * A `start` arriving after the token is claimed is rejected unless it matches.
   */
  authorizeHost(msg: HostMessage, conn: Party.Connection): boolean {
    const supplied = String(msg.hostToken ?? "").trim();

    // First `start` with a token claims the room.
    if (!this.hostToken) {
      if (msg.type === "start" && supplied) return true;
      // No host claimed yet and this isn't a claiming start — ignore.
      return false;
    }

    if (supplied === this.hostToken) return true;

    conn.send(JSON.stringify({ type: "error", reason: "not_host" }));
    return false;
  }

  // ── Handlers ─────────────────────────────────────────────────────────────

  handleJoin(msg: JoinMsg, conn: Party.Connection) {
    if (this.phase === "end") {
      conn.send(JSON.stringify({ type: "error", reason: "game_over" }));
      return;
    }

    let name = String(msg.nickname ?? "").trim().slice(0, 32);
    const token = String(msg.token ?? "").trim();
    if (!name || !token) return;

    // Deduplicate nickname
    if (this.players.has(name)) {
      let n = 2;
      while (this.players.has(`${name}_${n}`)) n++;
      name = `${name}_${n}`;
    }

    this.players.set(name, { name, score: 0, joinedAt: Date.now(), token, answers: {} });
    this.conns.set(conn.id, name);

    // Tell this player their (possibly adjusted) nickname
    conn.send(JSON.stringify({ type: "joined", nickname: name }));

    // Catch them up to the current game state
    this.sendCurrentState(conn, name);

    // Everyone gets the updated player list
    this.broadcastPlayerList();
    this.persist();
  }

  handleRejoin(msg: RejoinMsg, conn: Party.Connection) {
    const name  = String(msg.nickname ?? "").trim();
    const token = String(msg.token   ?? "").trim();
    const player = this.players.get(name);

    if (player && player.token === token) {
      this.conns.set(conn.id, name);
      conn.send(JSON.stringify({
        type:     "rejoined",
        nickname: name,
        score:    player.score,
        phase:    this.phase,
      }));
      this.sendCurrentState(conn, name);
    } else {
      conn.send(JSON.stringify({ type: "rejoin_failed" }));
    }
  }

  handleStart(msg: StartMsg, conn: Party.Connection) {
    if (this.phase !== "lobby") return;

    const questions = validateQuestions(msg.questions);
    if (!questions) {
      conn.send(JSON.stringify({ type: "error", reason: "bad_quiz" }));
      return;
    }

    // Claim host ownership of the room (authorizeHost already verified a token).
    this.hostToken    = String(msg.hostToken ?? "").trim();
    this.questions    = questions;
    this.quizTitle    = String(msg.title ?? "WMG Quiz");
    this.defaultTime  = Number(msg.defaultTime) || 30;
    this.flatScoring  = !!msg.flatScoring;
    this.currentQ     = 0;
    this.phase        = "question";
    this.timerStarted = false;
    this.answers.clear();

    this.broadcastPreQuestion();
    this.persist();
  }

  handleBeginTimer(_conn: Party.Connection) {
    if (this.phase !== "question" || this.timerStarted) return;

    this.timerStarted      = true;
    this.questionStartTime = Date.now();

    const q = this.questions[this.currentQ];
    this.room.broadcast(JSON.stringify({
      type:              "timer_started",
      index:             this.currentQ,
      total:             this.questions.length,
      question:          { q: q.q, answers: q.answers, time: q.time ?? this.defaultTime },
      questionStartTime: this.questionStartTime,
    }));
    this.persist();
  }

  handleAnswer(msg: AnswerMsg, conn: Party.Connection) {
    if (this.phase !== "question" || !this.timerStarted) return;

    const name = this.conns.get(conn.id);
    if (!name || this.answers.has(name)) return;

    const idx = Number(msg.answerIndex);
    const maxIdx = this.questions[this.currentQ].answers.length - 1;
    if (!Number.isInteger(idx) || idx < 0 || idx > maxIdx) return;

    this.answers.set(name, { answerIndex: idx, answeredAt: Date.now() });

    // Log answer in the player's permanent record (for CSV export)
    const player = this.players.get(name);
    if (player) player.answers[this.currentQ] = idx;

    // Confirm to this player only (they go to locked state)
    conn.send(JSON.stringify({ type: "answer_received", answerIndex: idx }));

    // Everyone gets the anonymous count (drives progress bar on locked screen)
    this.room.broadcast(JSON.stringify({
      type:  "answer_count",
      count: this.answers.size,
      total: this.players.size,
    }));
    this.persist();
  }

  handleNext(_conn: Party.Connection) {
    if (this.phase === "question") {
      // Freeze answers, calculate scores, show reveal
      this.calculateScores();
      this.phase = "reveal";
      this.broadcastReveal();

    } else if (this.phase === "reveal") {
      // Host clicked "Show leaderboard"
      this.phase = "leaderboard";
      this.room.broadcast(JSON.stringify({
        type:           "leaderboard",
        leaderboard:    this.getLeaderboard(),
        questionIndex:  this.currentQ,
        totalQuestions: this.questions.length,
      }));

    } else if (this.phase === "leaderboard") {
      // Host clicked "Next question" or "End game" if on last
      const nextIdx = this.currentQ + 1;
      if (nextIdx >= this.questions.length) {
        this.phase = "end";
        this.broadcastGameOver();
      } else {
        this.currentQ++;
        this.phase        = "question";
        this.timerStarted = false;
        this.answers.clear();
        this.broadcastPreQuestion();
      }
    }
    this.persist();
  }

  handleEnd() {
    this.phase = "end";
    this.broadcastGameOver();
    this.persist();
  }

  // ── Score calculation ─────────────────────────────────────────────────────

  calculateScores() {
    const q            = this.questions[this.currentQ];
    const timeLimitSecs = q.time ?? this.defaultTime;

    for (const [name, answer] of this.answers) {
      const player = this.players.get(name);
      if (!player) continue;
      player.score += scoreAnswer({
        correct:       answer.answerIndex === q.correct,
        flat:          this.flatScoring,
        answeredAt:    answer.answeredAt,
        questionStart: this.questionStartTime,
        timeLimitSecs,
      });
    }
  }

  // ── Broadcasts ────────────────────────────────────────────────────────────

  broadcastPreQuestion() {
    const q = this.questions[this.currentQ];
    this.room.broadcast(JSON.stringify({
      type:     "pre_question",
      index:    this.currentQ,
      total:    this.questions.length,
      question: { q: q.q, answers: q.answers, time: q.time ?? this.defaultTime },
    }));
  }

  broadcastReveal() {
    const q            = this.questions[this.currentQ];
    const timeLimitSecs = q.time ?? this.defaultTime;
    const counts       = Array(q.answers.length).fill(0);
    const roundScores: Record<string, number> = {};
    const chosen:      Record<string, number> = {};

    for (const [name, answer] of this.answers) {
      counts[answer.answerIndex]++;
      chosen[name] = answer.answerIndex;
      roundScores[name] = scoreAnswer({
        correct:       answer.answerIndex === q.correct,
        flat:          this.flatScoring,
        answeredAt:    answer.answeredAt,
        questionStart: this.questionStartTime,
        timeLimitSecs,
      });
    }

    this.room.broadcast(JSON.stringify({
      type:        "reveal",
      correct:     q.correct,
      counts,
      question:    { q: q.q, answers: q.answers },
      roundScores,
      chosen,
      leaderboard: this.getLeaderboard(),
    }));
  }

  broadcastGameOver() {
    // Build per-player answer log for host CSV export
    const playerAnswers: Record<string, Record<number, number>> = {};
    for (const [name, player] of this.players) {
      playerAnswers[name] = player.answers;
    }
    this.room.broadcast(JSON.stringify({
      type:          "game_over",
      leaderboard:   this.getLeaderboard(),
      playerAnswers,
      questions:     this.questions.map(q => ({ correct: q.correct })),
    }));
  }

  broadcastPlayerList() {
    this.room.broadcast(JSON.stringify({
      type:    "player_list",
      players: Array.from(this.players.values()).map(p => ({ name: p.name })),
      count:   this.players.size,
    }));
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  getLeaderboard() {
    return Array.from(this.players.values())
      .sort((a, b) => b.score - a.score)
      .map((p, i) => ({ rank: i + 1, name: p.name, score: p.score }));
  }

  /**
   * Send the current game state to a freshly-connected / rejoined player.
   */
  sendCurrentState(conn: Party.Connection, nickname: string) {
    if (this.phase === "lobby") return; // nothing to send

    const q = this.questions[this.currentQ];

    if (this.phase === "question") {
      if (!this.timerStarted) {
        conn.send(JSON.stringify({
          type:     "pre_question",
          index:    this.currentQ,
          total:    this.questions.length,
          question: { q: q.q, answers: q.answers, time: q.time ?? this.defaultTime },
        }));
      } else {
        // Question in progress — already answered?
        const alreadyAnswered = this.answers.has(nickname);
        conn.send(JSON.stringify({
          type:              alreadyAnswered ? "answer_received_late" : "timer_started",
          index:             this.currentQ,
          total:             this.questions.length,
          question:          { q: q.q, answers: q.answers, time: q.time ?? this.defaultTime },
          questionStartTime: this.questionStartTime,
          answerIndex:       alreadyAnswered ? this.answers.get(nickname)!.answerIndex : undefined,
          answerCount:       this.answers.size,
          playerCount:       this.players.size,
        }));
      }

    } else if (this.phase === "reveal") {
      // Re-send the reveal so the player sees results
      const counts      = Array(q.answers.length).fill(0);
      const roundScores: Record<string, number> = {};
      const chosen:      Record<string, number> = {};
      const timeLimitSecs = q.time ?? this.defaultTime;

      for (const [name, answer] of this.answers) {
        counts[answer.answerIndex]++;
        chosen[name] = answer.answerIndex;
        roundScores[name] = scoreAnswer({
          correct:       answer.answerIndex === q.correct,
          flat:          this.flatScoring,
          answeredAt:    answer.answeredAt,
          questionStart: this.questionStartTime,
          timeLimitSecs,
        });
      }
      conn.send(JSON.stringify({
        type:        "reveal",
        correct:     q.correct,
        counts,
        question:    { q: q.q, answers: q.answers },
        roundScores,
        chosen,
        leaderboard: this.getLeaderboard(),
      }));

    } else if (this.phase === "leaderboard") {
      conn.send(JSON.stringify({
        type:           "leaderboard",
        leaderboard:    this.getLeaderboard(),
        questionIndex:  this.currentQ,
        totalQuestions: this.questions.length,
      }));

    } else if (this.phase === "end") {
      conn.send(JSON.stringify({
        type:        "game_over",
        leaderboard: this.getLeaderboard(),
      }));
    }
  }
}
