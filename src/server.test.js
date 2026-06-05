import { test } from "node:test";
import assert from "node:assert/strict";
import QuizServer from "../party/server.ts";

// ── Mocks ────────────────────────────────────────────────────────────────────
// The server only touches room.broadcast, room.storage.{get,put,delete}, and
// conn.{id,send}. These mocks capture everything so tests can assert on it.

function mockRoom() {
  const broadcasts = [];
  const store = new Map();
  return {
    broadcasts,
    store,
    broadcast: (raw) => broadcasts.push(JSON.parse(raw)),
    storage: {
      get: async (k) => (store.has(k) ? store.get(k) : null),
      put: async (k, v) => void store.set(k, v),
      delete: async (k) => void store.delete(k),
    },
  };
}

function mockConn(id) {
  const inbox = [];
  return { id, inbox, send: (raw) => inbox.push(JSON.parse(raw)) };
}

const send = (server, conn, msg) => server.onMessage(JSON.stringify(msg), conn);

const QUIZ = [
  { q: "Q1", answers: ["a", "b", "c", "d"], correct: 0 },
  { q: "Q2", answers: ["x", "y"], correct: 1 },
];

// Build a server with one joined player; returns handles.
function setup() {
  const room = mockRoom();
  const server = new QuizServer(room);
  const host = mockConn("host");
  const player = mockConn("player");
  return { room, server, host, player };
}

const types = (arr) => arr.map((m) => m.type + (m.reason ? `:${m.reason}` : ""));

// ── Host authorization ───────────────────────────────────────────────────────

test("first start with a token claims the room; phase advances to question", () => {
  const { server, host } = setup();
  send(server, host, { type: "start", hostToken: "HT", questions: QUIZ });
  assert.equal(server.phase, "question");
  assert.equal(server.hostToken, "HT");
});

test("a non-host next/end is rejected and does not advance the game", () => {
  const { server, host } = setup();
  send(server, host, { type: "start", hostToken: "HT", questions: QUIZ });

  const attacker = mockConn("attacker");
  send(server, attacker, { type: "next" });           // no token
  send(server, attacker, { type: "end" });            // no token

  assert.equal(server.phase, "question", "attacker must not advance the game");
  assert.deepEqual(types(attacker.inbox), ["error:not_host", "error:not_host"]);
});

test("the token holder can advance the game", () => {
  const { server, host } = setup();
  send(server, host, { type: "start", hostToken: "HT", questions: QUIZ });
  send(server, host, { type: "begin_timer", hostToken: "HT" });
  send(server, host, { type: "next", hostToken: "HT" });   // question -> reveal
  assert.equal(server.phase, "reveal");
});

test("begin_timer before any start is ignored (no host claimed yet)", () => {
  const { server, host } = setup();
  send(server, host, { type: "begin_timer", hostToken: "HT" });
  assert.equal(server.phase, "lobby");
});

// ── Validation path ──────────────────────────────────────────────────────────

test("start with an out-of-range correct index is rejected as bad_quiz", () => {
  const { server, host } = setup();
  send(server, host, {
    type: "start",
    hostToken: "HT",
    questions: [{ q: "Q", answers: ["a", "b", "c", "d"], correct: 9 }],
  });
  assert.equal(server.phase, "lobby");
  assert.deepEqual(types(host.inbox), ["error:bad_quiz"]);
});

// ── Phase machine ────────────────────────────────────────────────────────────

test("full phase walk: lobby -> question -> reveal -> leaderboard -> question -> end", () => {
  const { server, host, player, room } = setup();
  send(server, player, { type: "join", nickname: "Alice", token: "p1" });
  send(server, host, { type: "start", hostToken: "HT", questions: QUIZ });
  assert.equal(server.phase, "question");

  send(server, host, { type: "begin_timer", hostToken: "HT" });
  assert.ok(room.broadcasts.some((m) => m.type === "timer_started"));

  send(server, host, { type: "next", hostToken: "HT" });   // -> reveal
  assert.equal(server.phase, "reveal");
  send(server, host, { type: "next", hostToken: "HT" });   // -> leaderboard
  assert.equal(server.phase, "leaderboard");
  send(server, host, { type: "next", hostToken: "HT" });   // -> Q2 question
  assert.equal(server.phase, "question");
  assert.equal(server.currentQ, 1);

  send(server, host, { type: "begin_timer", hostToken: "HT" });
  send(server, host, { type: "next", hostToken: "HT" });   // reveal
  send(server, host, { type: "next", hostToken: "HT" });   // leaderboard
  send(server, host, { type: "next", hostToken: "HT" });   // last question -> end
  assert.equal(server.phase, "end");
  assert.ok(room.broadcasts.some((m) => m.type === "game_over"));
});

test("answer is recorded and an answer_count is broadcast", () => {
  const { server, host, player, room } = setup();
  send(server, player, { type: "join", nickname: "Alice", token: "p1" });
  send(server, host, { type: "start", hostToken: "HT", questions: QUIZ });
  send(server, host, { type: "begin_timer", hostToken: "HT" });
  send(server, player, { type: "answer", answerIndex: 0 });

  assert.equal(server.answers.size, 1);
  assert.ok(player.inbox.some((m) => m.type === "answer_received"));
  assert.ok(room.broadcasts.some((m) => m.type === "answer_count"));
});

test("an out-of-range answer index is ignored", () => {
  const { server, host, player } = setup();
  send(server, player, { type: "join", nickname: "Alice", token: "p1" });
  send(server, host, { type: "start", hostToken: "HT", questions: QUIZ });
  send(server, host, { type: "begin_timer", hostToken: "HT" });
  send(server, player, { type: "answer", answerIndex: 7 }); // Q1 has 4 answers
  assert.equal(server.answers.size, 0);
});

// ── Scoring integration ──────────────────────────────────────────────────────

test("a correct answer awards points reflected in reveal + leaderboard", () => {
  const { server, host, player, room } = setup();
  send(server, player, { type: "join", nickname: "Alice", token: "p1" });
  send(server, host, { type: "start", hostToken: "HT", questions: QUIZ });
  send(server, host, { type: "begin_timer", hostToken: "HT" });
  send(server, player, { type: "answer", answerIndex: 0 }); // Q1 correct = 0
  send(server, host, { type: "next", hostToken: "HT" });    // reveal

  const reveal = room.broadcasts.find((m) => m.type === "reveal");
  assert.ok(reveal, "expected a reveal broadcast");
  assert.ok(reveal.roundScores.Alice > 0, "correct answer should score > 0");
  const top = reveal.leaderboard.find((p) => p.name === "Alice");
  assert.ok(top && top.score > 0);
});

test("a wrong answer scores zero", () => {
  const { server, host, player, room } = setup();
  send(server, player, { type: "join", nickname: "Bob", token: "p2" });
  send(server, host, { type: "start", hostToken: "HT", questions: QUIZ });
  send(server, host, { type: "begin_timer", hostToken: "HT" });
  send(server, player, { type: "answer", answerIndex: 3 }); // wrong
  send(server, host, { type: "next", hostToken: "HT" });

  const reveal = room.broadcasts.find((m) => m.type === "reveal");
  assert.equal(reveal.roundScores.Bob, 0);
});

// ── Rejoin + persistence (durability) ────────────────────────────────────────

test("late join after game over is refused with error:game_over", () => {
  const { server, host, player } = setup();
  send(server, host, { type: "start", hostToken: "HT", questions: [QUIZ[0]] });
  send(server, host, { type: "begin_timer", hostToken: "HT" });
  send(server, host, { type: "next", hostToken: "HT" }); // reveal
  send(server, host, { type: "next", hostToken: "HT" }); // leaderboard
  send(server, host, { type: "next", hostToken: "HT" }); // end (single question)
  assert.equal(server.phase, "end");

  send(server, player, { type: "join", nickname: "Late", token: "lt" });
  assert.deepEqual(types(player.inbox), ["error:game_over"]);
});

test("state persists to storage and rehydrates into a fresh server", async () => {
  const room = mockRoom();
  const server = new QuizServer(room);
  const host = mockConn("host");
  const player = mockConn("player");

  send(server, player, { type: "join", nickname: "Alice", token: "p1" });
  send(server, host, { type: "start", hostToken: "HT", questions: QUIZ });
  send(server, host, { type: "begin_timer", hostToken: "HT" });
  send(server, player, { type: "answer", answerIndex: 0 });
  send(server, host, { type: "next", hostToken: "HT" }); // reveal — Alice scored
  send(server, host, { type: "next", hostToken: "HT" }); // leaderboard
  send(server, host, { type: "next", hostToken: "HT" }); // -> Q2
  await Promise.resolve();

  const snap = room.store.get("state");
  assert.ok(snap, "a snapshot should have been persisted");
  assert.equal(snap.currentQ, 1);

  // Simulate a fresh DO instance that rehydrates from the same storage.
  const room2 = mockRoom();
  room2.store.set("state", snap);
  const revived = new QuizServer(room2);
  await revived.onStart();

  assert.equal(revived.phase, "question");
  assert.equal(revived.currentQ, 1);

  const rejoinConn = mockConn("alice-2");
  send(revived, rejoinConn, { type: "rejoin", nickname: "Alice", token: "p1" });
  const rejoined = rejoinConn.inbox.find((m) => m.type === "rejoined");
  assert.ok(rejoined, "rejoin should succeed against rehydrated state");
  assert.ok(rejoined.score > 0, "Alice's score should survive the restart");
});

test("rejoin with a wrong token fails", () => {
  const { server, host, player } = setup();
  send(server, player, { type: "join", nickname: "Alice", token: "p1" });
  send(server, host, { type: "start", hostToken: "HT", questions: QUIZ });

  const bad = mockConn("imposter");
  send(server, bad, { type: "rejoin", nickname: "Alice", token: "WRONG" });
  assert.deepEqual(types(bad.inbox), ["rejoin_failed"]);
});
