import type * as Party from "partykit/server";

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

  constructor(readonly room: Party.Room) {}

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
    let msg: any;
    try { msg = JSON.parse(raw); } catch { return; }

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

  // ── Handlers ─────────────────────────────────────────────────────────────

  handleJoin(msg: any, conn: Party.Connection) {
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
  }

  handleRejoin(msg: any, conn: Party.Connection) {
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

  handleStart(msg: any, _conn: Party.Connection) {
    if (this.phase !== "lobby") return;
    if (!Array.isArray(msg.questions) || msg.questions.length === 0) return;

    this.questions    = msg.questions;
    this.quizTitle    = String(msg.title ?? "WMG Quiz");
    this.defaultTime  = Number(msg.defaultTime) || 30;
    this.flatScoring  = !!msg.flatScoring;
    this.currentQ     = 0;
    this.phase        = "question";
    this.timerStarted = false;
    this.answers.clear();

    this.broadcastPreQuestion();
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
  }

  handleAnswer(msg: any, conn: Party.Connection) {
    if (this.phase !== "question" || !this.timerStarted) return;

    const name = this.conns.get(conn.id);
    if (!name || this.answers.has(name)) return;

    const idx = Number(msg.answerIndex);
    if (!Number.isInteger(idx) || idx < 0 || idx > 3) return;

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
  }

  handleEnd() {
    this.phase = "end";
    this.broadcastGameOver();
  }

  // ── Score calculation ─────────────────────────────────────────────────────

  calculateScores() {
    const q         = this.questions[this.currentQ];
    const timeLimitMs = (q.time ?? this.defaultTime) * 1000;

    for (const [name, answer] of this.answers) {
      const player = this.players.get(name);
      if (!player || answer.answerIndex !== q.correct) continue;

      if (this.flatScoring) {
        player.score += 1000;
      } else {
        const elapsed   = Math.max(0, answer.answeredAt - this.questionStartTime);
        const fraction  = Math.min(1, elapsed / timeLimitMs);
        player.score   += Math.round(1000 * (1 - fraction / 2));
      }
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
    const q          = this.questions[this.currentQ];
    const timeLimitMs = (q.time ?? this.defaultTime) * 1000;
    const counts      = [0, 0, 0, 0];
    const roundScores: Record<string, number> = {};
    const chosen:      Record<string, number> = {};

    for (const [name, answer] of this.answers) {
      counts[answer.answerIndex]++;
      chosen[name] = answer.answerIndex;

      if (answer.answerIndex === q.correct) {
        if (this.flatScoring) {
          roundScores[name] = 1000;
        } else {
          const elapsed   = Math.max(0, answer.answeredAt - this.questionStartTime);
          const fraction  = Math.min(1, elapsed / timeLimitMs);
          roundScores[name] = Math.round(1000 * (1 - fraction / 2));
        }
      } else {
        roundScores[name] = 0;
      }
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
      const counts      = [0, 0, 0, 0];
      const roundScores: Record<string, number> = {};
      const chosen:      Record<string, number> = {};
      const timeLimitMs = (q.time ?? this.defaultTime) * 1000;

      for (const [name, answer] of this.answers) {
        counts[answer.answerIndex]++;
        chosen[name] = answer.answerIndex;
        if (answer.answerIndex === q.correct) {
          const elapsed  = Math.max(0, answer.answeredAt - this.questionStartTime);
          const fraction = Math.min(1, elapsed / timeLimitMs);
          roundScores[name] = this.flatScoring ? 1000 : Math.round(1000 * (1 - fraction / 2));
        } else {
          roundScores[name] = 0;
        }
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
