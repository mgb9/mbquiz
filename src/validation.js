// Upper bounds — guard against memory-exhaustion via an oversized quiz.
export const MAX_QUESTIONS   = 100;
export const MAX_ANSWERS     = 8;
export const MAX_Q_LEN       = 500;
export const MAX_ANSWER_LEN  = 200;

/**
 * Validate a client-supplied questions payload.
 *
 * Returns a normalized array of questions if every entry is well-formed, or
 * `null` if anything is off. This is the server's guard against malformed
 * quizzes — an out-of-range `correct` index or an empty `answers` array would
 * otherwise cause silent mis-scoring or downstream crashes.
 *
 * Requirements per question:
 *   - `q`        : non-empty string, ≤ MAX_Q_LEN chars
 *   - `answers`  : array of 2–MAX_ANSWERS strings, each ≤ MAX_ANSWER_LEN chars
 *   - `correct`  : integer index within `answers`
 *   - `time`     : optional, positive number (seconds)
 * The whole payload must hold 1–MAX_QUESTIONS questions.
 *
 * @param {unknown} raw
 * @returns {Array<{q: string, answers: string[], correct: number, time?: number}> | null}
 */
export function validateQuestions(raw) {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_QUESTIONS) return null;

  const out = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") return null;
    const { q, answers, correct, time } = item;

    if (typeof q !== "string" || q.trim() === "" || q.length > MAX_Q_LEN) return null;
    if (!Array.isArray(answers) || answers.length < 2 || answers.length > MAX_ANSWERS) return null;
    if (!answers.every(a => typeof a === "string" && a.length <= MAX_ANSWER_LEN)) return null;
    if (!Number.isInteger(correct) || correct < 0 || correct >= answers.length) return null;
    if (time !== undefined && (typeof time !== "number" || !(time > 0))) return null;

    const question = { q, answers, correct };
    if (time !== undefined) question.time = time;
    out.push(question);
  }
  return out;
}
