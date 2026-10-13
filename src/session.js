/**
 * session.js — per-room session persistence in localStorage
 *
 * Both the host (its secret token) and the player (nickname + token) keep a
 * map of { [room]: { ...data, savedAt } } under a single storage key, with
 * entries expiring after 4 hours. All storage failures are swallowed:
 * load() returns null and save()/clear() silently no-op.
 */

// Also how long the server keeps an idle room's game (party/worker.ts), so a
// saved session never outlives the game it would rejoin.
export const SESSION_MAX_AGE_MS = 4 * 60 * 60 * 1000;

export function createSessionStore(storageKey, maxAgeMs = SESSION_MAX_AGE_MS) {
  return {
    /** Entry for `room` if present and fresh, else null. */
    load(room) {
      try {
        const sessions = JSON.parse(localStorage.getItem(storageKey) || '{}');
        const s = sessions[room];
        if (s && Date.now() - s.savedAt < maxAgeMs) return s;
      } catch {}
      return null;
    },

    /** Store `data` under `room`, stamped with savedAt. */
    save(room, data) {
      try {
        const sessions = JSON.parse(localStorage.getItem(storageKey) || '{}');
        sessions[room] = { ...data, savedAt: Date.now() };
        localStorage.setItem(storageKey, JSON.stringify(sessions));
      } catch {}
    },

    /** Forget `room`'s entry. */
    clear(room) {
      try {
        const sessions = JSON.parse(localStorage.getItem(storageKey) || '{}');
        delete sessions[room];
        localStorage.setItem(storageKey, JSON.stringify(sessions));
      } catch {}
    },
  };
}
