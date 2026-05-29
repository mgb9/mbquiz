import { test } from "node:test";
import assert from "node:assert/strict";
import { calcScore, calcFlatScore, scoreAnswer } from "./scoring.js";

const LIMIT = 30; // seconds

test("calcScore: instant answer = 1000", () => {
  assert.equal(calcScore(1000, 1000, LIMIT), 1000);
});

test("calcScore: last-moment answer = 500", () => {
  assert.equal(calcScore(1000 + LIMIT * 1000, 1000, LIMIT), 500);
});

test("calcScore: half-time answer = 750", () => {
  assert.equal(calcScore(1000 + (LIMIT * 1000) / 2, 1000, LIMIT), 750);
});

test("calcScore: negative elapsed clamps to 1000", () => {
  assert.equal(calcScore(500, 1000, LIMIT), 1000);
});

test("calcScore: overshooting the limit clamps to 500", () => {
  assert.equal(calcScore(1000 + LIMIT * 1000 * 5, 1000, LIMIT), 500);
});

test("calcFlatScore: always 1000", () => {
  assert.equal(calcFlatScore(), 1000);
});

test("scoreAnswer: wrong answer = 0 regardless of speed", () => {
  assert.equal(
    scoreAnswer({ correct: false, flat: false, answeredAt: 1000, questionStart: 1000, timeLimitSecs: LIMIT }),
    0,
  );
});

test("scoreAnswer: correct flat answer = 1000", () => {
  assert.equal(
    scoreAnswer({ correct: true, flat: true, answeredAt: 1000 + LIMIT * 1000, questionStart: 1000, timeLimitSecs: LIMIT }),
    1000,
  );
});

test("scoreAnswer: correct speed answer matches calcScore", () => {
  const answeredAt = 1000 + (LIMIT * 1000) / 2;
  assert.equal(
    scoreAnswer({ correct: true, flat: false, answeredAt, questionStart: 1000, timeLimitSecs: LIMIT }),
    calcScore(answeredAt, 1000, LIMIT),
  );
});

test("scoreAnswer: wrong flat answer = 0", () => {
  assert.equal(
    scoreAnswer({ correct: false, flat: true, answeredAt: 1000, questionStart: 1000, timeLimitSecs: LIMIT }),
    0,
  );
});
