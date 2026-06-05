import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validateQuestions,
  MAX_QUESTIONS, MAX_ANSWERS, MAX_Q_LEN, MAX_ANSWER_LEN,
} from "./validation.js";

const valid = [
  { q: "Capital of France?", answers: ["Paris", "Lyon", "Nice", "Brest"], correct: 0 },
  { q: "2 + 2?", answers: ["3", "4"], correct: 1, time: 15 },
];

test("accepts a well-formed quiz and normalizes it", () => {
  const out = validateQuestions(valid);
  assert.equal(out?.length, 2);
  assert.equal(out[0].correct, 0);
  assert.equal(out[1].time, 15);
});

test("rejects an out-of-range correct index", () => {
  assert.equal(
    validateQuestions([{ q: "Q", answers: ["a", "b", "c", "d"], correct: 9 }]),
    null,
  );
});

test("rejects a negative correct index", () => {
  assert.equal(validateQuestions([{ q: "Q", answers: ["a", "b"], correct: -1 }]), null);
});

test("rejects fewer than 2 answers", () => {
  assert.equal(validateQuestions([{ q: "Q", answers: ["only"], correct: 0 }]), null);
  assert.equal(validateQuestions([{ q: "Q", answers: [], correct: 0 }]), null);
});

test("rejects a non-string question", () => {
  assert.equal(validateQuestions([{ q: 42, answers: ["a", "b"], correct: 0 }]), null);
  assert.equal(validateQuestions([{ q: "  ", answers: ["a", "b"], correct: 0 }]), null);
});

test("rejects non-string answers", () => {
  assert.equal(validateQuestions([{ q: "Q", answers: ["a", 2], correct: 0 }]), null);
});

test("rejects a non-integer correct index", () => {
  assert.equal(validateQuestions([{ q: "Q", answers: ["a", "b"], correct: 1.5 }]), null);
});

test("rejects an invalid time override", () => {
  assert.equal(validateQuestions([{ q: "Q", answers: ["a", "b"], correct: 0, time: 0 }]), null);
  assert.equal(validateQuestions([{ q: "Q", answers: ["a", "b"], correct: 0, time: -5 }]), null);
});

test("rejects empty or non-array payloads", () => {
  assert.equal(validateQuestions([]), null);
  assert.equal(validateQuestions(null), null);
  assert.equal(validateQuestions("nope"), null);
});

// ── Upper bounds (abuse limits) ──────────────────────────────────────────────

const oneQ = (over = {}) => ({ q: "Q", answers: ["a", "b"], correct: 0, ...over });

test("rejects more than MAX_QUESTIONS questions", () => {
  const tooMany = Array.from({ length: MAX_QUESTIONS + 1 }, () => oneQ());
  assert.equal(validateQuestions(tooMany), null);
  // exactly at the limit is fine
  const atLimit = Array.from({ length: MAX_QUESTIONS }, () => oneQ());
  assert.equal(validateQuestions(atLimit)?.length, MAX_QUESTIONS);
});

test("rejects an over-long question string", () => {
  assert.equal(validateQuestions([oneQ({ q: "x".repeat(MAX_Q_LEN + 1) })]), null);
  assert.ok(validateQuestions([oneQ({ q: "x".repeat(MAX_Q_LEN) })]));
});

test("rejects more than MAX_ANSWERS answers", () => {
  const answers = Array.from({ length: MAX_ANSWERS + 1 }, (_, i) => `a${i}`);
  assert.equal(validateQuestions([{ q: "Q", answers, correct: 0 }]), null);
});

test("rejects an over-long answer string", () => {
  assert.equal(validateQuestions([oneQ({ answers: ["a", "y".repeat(MAX_ANSWER_LEN + 1)] })]), null);
  assert.ok(validateQuestions([oneQ({ answers: ["a", "y".repeat(MAX_ANSWER_LEN)] })]));
});
