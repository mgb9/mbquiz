/**
 * audio.js — the one low-level Web Audio primitive shared by both views.
 *
 * The host and player synthesise sound differently (the host loops music
 * through a mutable master-gain node and tracks oscillators so it can stop/mute
 * them; the player fires one-shot effects straight to the destination), so that
 * orchestration stays in each file. What they *did* duplicate was the per-note
 * envelope scheduling — that lives here.
 *
 * The envelope timing constants are parameters rather than hard-coded so each
 * caller keeps its exact original sound.
 */

/**
 * Schedule a single tone with a short attack/sustain/release envelope.
 *
 * @param {AudioContext} ctx
 * @param {AudioNode}    dest     - where the note's gain node connects (master gain or ctx.destination)
 * @param {object} o
 * @param {number} o.freq         - frequency in Hz; falsy (0) schedules nothing (a rest)
 * @param {number} o.at           - context time to start the note
 * @param {number} o.dur          - note duration in seconds
 * @param {OscillatorType} o.wave - oscillator waveform
 * @param {number} o.vol          - peak gain
 * @param {number} o.attCap       - max attack time (s)
 * @param {number} o.attMul       - attack as a fraction of duration
 * @param {number} o.relCap       - max release time (s)
 * @returns {OscillatorNode|null} the oscillator (so callers can track it), or null for a rest
 */
export function scheduleTone(ctx, dest, { freq, at, dur, wave, vol, attCap, attMul, relCap }) {
  if (!freq) return null;
  const osc = ctx.createOscillator();
  const env = ctx.createGain();
  const att = Math.min(attCap, dur * attMul);
  const rel = Math.min(relCap, dur * 0.4);
  osc.type = wave;
  osc.frequency.value = freq;
  env.gain.setValueAtTime(0, at);
  env.gain.linearRampToValueAtTime(vol, at + att);
  env.gain.setValueAtTime(vol, at + dur - rel);
  env.gain.exponentialRampToValueAtTime(0.0001, at + dur - 0.005);
  osc.connect(env); env.connect(dest);
  osc.start(at); osc.stop(at + dur);
  return osc;
}
