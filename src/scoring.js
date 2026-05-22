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
