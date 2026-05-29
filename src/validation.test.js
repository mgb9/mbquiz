import { test } from "node:test";
import assert from "node:assert/strict";
import { validateQuestions } from "./validation.js";

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
