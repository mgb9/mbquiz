/**
 * Calculate points for a correct answer.
 *
 * Kahoot-style speed scoring:
 *   - 1000 pts for an instant answer
 *   - 500 pts for an answer at the very last moment
 *   - Linear interpolation between 0ms → 1000 pts and timeLimit → 500 pts
 *
 * @param {number} answeredAt     - server timestamp (ms) when the answer arrived
 * @param {number} questionStart  - server timestamp (ms) when the timer started
 * @param {number} timeLimitSecs  - question time limit in seconds
 * @returns {number} pts (0 if wrong; caller is responsible for checking correct)
 */
export function calcScore(answeredAt, questionStart, timeLimitSecs) {
  const elapsed  = Math.max(0, answeredAt - questionStart);          // ms elapsed
  const timeLimit = timeLimitSecs * 1000;                           // convert to ms
  const fraction  = Math.min(1, elapsed / timeLimit);               // 0.0 → 1.0
  return Math.round(1000 * (1 - fraction / 2));                     // 1000 → 500
}

/**
 * Flat (non-speed-based) scoring — always 1000 pts for a correct answer.
 */
export function calcFlatScore() {
  return 1000;
}

/**
 * Single entry point for scoring one player's answer. Used everywhere the
 * server needs points — keeps the formula (and the wrong-answer = 0 rule) in
 * exactly one place.
 *
 * @param {object} o
 * @param {boolean} o.correct        - did the player pick the right answer?
 * @param {boolean} o.flat           - flat scoring mode (1000 flat, no speed bonus)
 * @param {number}  o.answeredAt     - server ms timestamp when the answer arrived
 * @param {number}  o.questionStart  - server ms timestamp when the timer started
 * @param {number}  o.timeLimitSecs  - question time limit in seconds
 * @returns {number} points awarded (0 if wrong)
 */
export function scoreAnswer({ correct, flat, answeredAt, questionStart, timeLimitSecs }) {
  if (!correct) return 0;
  return flat ? calcFlatScore() : calcScore(answeredAt, questionStart, timeLimitSecs);
}
