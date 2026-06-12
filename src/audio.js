/**
 * audio.js — the Web Audio synth shared by both views.
 *
 * Everything is synthesised — no files, no CDN. Each view creates its own
 * synth via createSynth(): the host loops music through a mutable master-gain
 * node (so it can mute) and tracks oscillators (so it can stop them); the
 * player fires one-shot effects straight to the destination. The track/SFX
 * note sequences stay in each view's file.
 *
 * The envelope timing constants are parameters rather than hard-coded so each
 * caller keeps its exact original sound.
 */

// Note frequencies (Hz)
export const NOTES = {
  G3:196.0, A3:220.0, B3:246.9,
  C4:261.6, D4:293.7, E4:329.6, F4:349.2, G4:392.0, A4:440.0, B4:493.9,
  C5:523.3, D5:587.3, E5:659.3, F5:698.5, G5:784.0, A5:880.0, B5:987.8, C6:1046.5,
};

/**
 * Create a lazy Web Audio synth. The AudioContext is only created on the
 * first play call — i.e. inside a user-gesture handler — never up front,
 * so browser autoplay policies are respected.
 *
 * @param {object} [o]
 * @param {number|null} o.masterGain - gain level for a master gain node notes route
 *   through (mutable, enables toggleMute); null plays straight to ctx.destination
 * @param {number} o.attCap  - max attack time (s), passed to scheduleTone
 * @param {number} o.attMul  - attack as a fraction of duration
 * @param {number} o.relCap  - max release time (s)
 * @param {number} o.lead    - scheduling lead time (s); ≥40ms so notes survive
 *   an async resume() of a suspended context
 */
export function createSynth({ masterGain = null, attCap, attMul, relCap, lead = 0.05 } = {}) {
  let ctx = null, gainNode = null, muted = false, loopTimer = null, nodes = [];

  function getCtx() {
    if (!ctx) {
      try {
        ctx = new (window.AudioContext || window.webkitAudioContext)();
        if (masterGain != null) {
          gainNode = ctx.createGain();
          gainNode.gain.value = masterGain;
          gainNode.connect(ctx.destination);
        }
      } catch (e) { return null; }
    }
    // resume() is async but notes scheduled slightly in the future (≥40 ms)
    // will still play correctly once the context unblocks.
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    return ctx;
  }

  // Schedule an array of [freq, beats] (freq=0 → rest). Returns end time.
  function sched(seq, bpm, wave, vol, t0) {
    const c = getCtx(); if (!c) return t0;
    const beat = 60 / bpm;
    let t = t0;
    seq.forEach(([f, b]) => {
      const dur = b * beat;
      const osc = scheduleTone(c, gainNode || c.destination, { freq: f, at: t, dur, wave, vol, attCap, attMul, relCap });
      if (osc) nodes.push(osc);
      t += dur;
    });
    return t;
  }

  return {
    /** Play a [freq, beats] sequence once. */
    playOnce(seq, bpm, wave, vol) {
      const c = getCtx(); if (!c) return;
      sched(seq, bpm, wave, vol, c.currentTime + lead);
    },

    /** Loop a [freq, beats] sequence until stop(); replaces any current loop. */
    playLoop(seq, bpm, wave, vol) {
      this.stop();
      const c = getCtx(); if (!c) return;
      const totalSecs = seq.reduce((s, [, b]) => s + b, 0) * (60 / bpm);
      function go(start) {
        nodes = []; // prune expired refs each iteration
        const end = sched(seq, bpm, wave, vol, start);
        loopTimer = setTimeout(() => go(end), (totalSecs - 0.3) * 1000);
      }
      go(c.currentTime + lead);
    },

    /** Cancel the loop and silence any scheduled notes. */
    stop() {
      clearTimeout(loopTimer); loopTimer = null;
      nodes.forEach(n => { try { n.stop(0); } catch (e) {} });
      nodes = [];
    },

    /** Toggle the master gain (no-op without masterGain). Returns the muted flag. */
    toggleMute() {
      muted = !muted;
      if (gainNode) gainNode.gain.setTargetAtTime(muted ? 0 : masterGain, ctx.currentTime, 0.05);
      return muted;
    },

    get muted() { return muted; },
  };
}

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
