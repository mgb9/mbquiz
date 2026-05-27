/**
 * host.js — WMG Quiz host view logic
 *
 * Manages the full host state machine:
 *   setup → lobby → pre_question → question → reveal → leaderboard → (loop) → final
 *
 * Space bar starts the timer on the pre-question screen.
 */

import { PARTYKIT_HOST } from './config.js';

// ── Design tokens ──────────────────────────────────────────────────────────
const C = {
  red:     '#EE3124',
  blue:    '#009DDC',
  gold:    '#FBB034',
  lime:    '#C1D82F',
  orange:  '#F47920',
  dark:    '#211F25',
  grey:    '#6D6E71',
  chalk:   '#FAFAF8',
  ink:     '#1A1820',
  inkSoft: '#3A3641',
};

const TILES = [
  { letter: 'A', color: C.red,    shape: 'triangle' },
  { letter: 'B', color: C.blue,   shape: 'diamond'  },
  { letter: 'C', color: C.gold,   shape: 'circle'   },
  { letter: 'D', color: C.lime,   shape: 'square'   },
];

// ── State ──────────────────────────────────────────────────────────────────
const S = {
  phase:         'setup',  // setup|lobby|pre_question|question|reveal|leaderboard|final
  room:          '',
  questions:     [],
  quizTitle:     '',
  defaultTime:   30,
  flatScoring:   false,
  players:       [],       // [{ name }]
  playerCount:   0,
  answeredCount: 0,
  totalPlayers:  0,
  qIndex:        0,        // 1-based current question index
  qTotal:        0,
  currentQ:      null,     // { q, answers, time }
  questionStart: 0,
  revealData:    null,     // { correct, counts, question, roundScores, leaderboard }
  leaderboard:      [],
  playerAnswers:    {},   // name → { qIndex: chosenAnswerIndex }
  questionCorrects: [],   // correct answer index per question (populated on game_over)
  timerInterval:    null,
};

// ── WebSocket ──────────────────────────────────────────────────────────────
let ws = null;

function connect(room) {
  if (ws) ws.close();
  const url = `wss://${PARTYKIT_HOST}/party/${encodeURIComponent(room)}`;
  ws = new WebSocket(url);
  const thisWs = ws; // capture so the close handler knows if it's been superseded

  ws.addEventListener('open', () => {
    console.log('[WMG Quiz Host] connected to room:', room);
  });
  ws.addEventListener('message', e => {
    try { onMessage(JSON.parse(e.data)); } catch (err) { console.error(err); }
  });
  ws.addEventListener('close', () => {
    // If ws has already been replaced by a newer connect() call, don't reconnect.
    if (ws !== thisWs) return;
    if (S.phase !== 'setup') {
      setTimeout(() => connect(S.room), 2000);
    }
  });
  ws.addEventListener('error', () => ws.close());
}

function send(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

// ── Audio ──────────────────────────────────────────────────────────────────
// All music is synthesised via the Web Audio API — no files, no CDN.

let _actx = null, _mGain = null, _muted = false, _loopTimer = null, _anodes = [];
let _host5sWarned = false; // prevents the 5-second stinger from firing more than once per question

// Note frequencies (Hz)
const N = {
  G3:196.0, A3:220.0, B3:246.9,
  C4:261.6, D4:293.7, E4:329.6, F4:349.2, G4:392.0, A4:440.0, B4:493.9,
  C5:523.3, D5:587.3, E5:659.3, F5:698.5, G5:784.0, A5:880.0, B5:987.8, C6:1046.5,
};

function _getCtx() {
  if (!_actx) {
    try {
      _actx = new (window.AudioContext || window.webkitAudioContext)();
      _mGain = _actx.createGain();
      _mGain.gain.value = 0.22;
      _mGain.connect(_actx.destination);
    } catch(e) { return null; }
  }
  // resume() is async but notes scheduled slightly in the future (≥50 ms)
  // will still play correctly once the context unblocks.
  if (_actx.state === 'suspended') _actx.resume().catch(() => {});
  return _actx;
}

function stopMusic() {
  clearTimeout(_loopTimer); _loopTimer = null;
  _anodes.forEach(n => { try { n.stop(0); } catch(e) {} });
  _anodes = [];
}

function toggleMute() {
  _muted = !_muted;
  if (_mGain) _mGain.gain.setTargetAtTime(_muted ? 0 : 0.22, _actx.currentTime, 0.05);
  return _muted;
}

// Schedule an array of [freq, beats] (freq=0 → rest). Returns end time.
function _sched(seq, bpm, wave, vol, t0) {
  const ctx = _getCtx(); if (!ctx) return t0;
  const beat = 60 / bpm;
  let t = t0;
  seq.forEach(([f, b]) => {
    const dur = b * beat;
    if (f) {
      const osc = ctx.createOscillator();
      const env = ctx.createGain();
      const att = Math.min(0.02, dur * 0.12);
      const rel = Math.min(0.12, dur * 0.4);
      osc.type = wave;
      osc.frequency.value = f;
      env.gain.setValueAtTime(0, t);
      env.gain.linearRampToValueAtTime(vol, t + att);
      env.gain.setValueAtTime(vol, t + dur - rel);
      env.gain.exponentialRampToValueAtTime(0.0001, t + dur - 0.005);
      osc.connect(env); env.connect(_mGain);
      osc.start(t); osc.stop(t + dur);
      _anodes.push(osc);
    }
    t += dur;
  });
  return t;
}

function _loop(seq, bpm, wave, vol) {
  stopMusic();
  const ctx = _getCtx(); if (!ctx) return;
  const totalSecs = seq.reduce((s, [, b]) => s + b, 0) * (60 / bpm);
  function go(start) {
    _anodes = []; // prune expired refs each iteration
    const end = _sched(seq, bpm, wave, vol, start);
    _loopTimer = setTimeout(() => go(end), (totalSecs - 0.3) * 1000);
  }
  go(ctx.currentTime + 0.05);
}

function _once(seq, bpm, wave, vol) {
  const ctx = _getCtx(); if (!ctx) return;
  _sched(seq, bpm, wave, vol, ctx.currentTime + 0.05);
}

// Lobby: 4-phrase C-major melody, ~15s loop — long enough not to feel repetitive
function startLobbyMusic() {
  _loop([
    // Phrase A — C major bounce
    [N.E5,.5],[N.G5,.5],[N.A5,.5],[N.G5,.5],[N.E5,.5],[N.D5,.5],[N.C5,1],
    [N.G5,.5],[N.E5,.5],[N.D5,.5],[N.C5,.5],[N.G4,1.5],[0,.5],
    // Phrase B — up through G and back
    [N.G5,.5],[N.A5,.5],[N.C6,.5],[N.A5,.5],[N.G5,.5],[N.E5,.5],[N.D5,1],
    [N.F5,.5],[N.A5,.5],[N.G5,.5],[N.E5,.5],[N.D5,1.5],[0,.5],
    // Phrase C — F major colour
    [N.F5,.5],[N.A5,.5],[N.C6,.5],[N.A5,.5],[N.F5,.5],[N.G5,.5],[N.A5,1],
    [N.C6,.5],[N.A5,.5],[N.G5,.5],[N.F5,.5],[N.E5,1.5],[0,.5],
    // Phrase D — home to C
    [N.E5,.5],[N.G5,.5],[N.A5,.5],[N.G5,.5],[N.E5,.5],[N.D5,.5],[N.C5,1],
    [N.G4,.5],[N.A4,.5],[N.C5,.5],[N.D5,.5],[N.C5,2],
  ], 130, 'triangle', 0.15);
}

// Question: 16-beat tense A-minor pulse (~7s loop) — two varied phrases
function startQuestionMusic() {
  _loop([
    // Phrase 1
    [N.A4,.5],[0,.5],[N.A4,.5],[0,.5],
    [N.G4,.5],[0,.5],[N.A4,.5],[0,.5],
    [N.A4,.5],[N.C5,.25],[N.B4,.25],[N.A4,.5],[N.G4,.5],
    [N.A4,2],
    // Phrase 2 — slightly different rhythm
    [N.A4,.5],[0,.25],[N.A4,.25],[N.A4,.5],[0,.5],
    [N.B4,.5],[0,.5],[N.A4,.5],[0,.5],
    [N.C5,.5],[N.B4,.5],[N.A4,.5],[N.G4,.5],
    [N.A4,2],
  ], 140, 'square', 0.09);
}

// Reveal: ascending C-major fanfare (plays once)
function playRevealStinger() {
  _once([
    [N.C5,.2],[N.E5,.2],[N.G5,.2],[N.C6,.45],
  ], 160, 'triangle', 0.18);
}

// Podium: triumphant C-major loop
function startPodiumMusic() {
  _loop([
    [N.C5,.5],[N.E5,.5],[N.G5,.5],[N.C6,.5],
    [N.G5,.5],[N.C6,.5],[N.G5,1],
    [N.E5,.5],[N.G5,.5],[N.C6,.5],[N.G5,.5],
    [N.C6,2],
  ], 108, 'triangle', 0.16);
}

// Confetti burst using WMG brand colours — pure canvas, no library
function launchConfetti() {
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:9998;';
  canvas.width  = window.innerWidth;
  canvas.height = window.innerHeight;
  document.body.appendChild(canvas);
  const ctx2 = canvas.getContext('2d');
  const cols  = [C.red, C.blue, C.gold, C.lime, C.orange, '#fff', '#fff'];
  const pieces = Array.from({length: 160}, () => ({
    x:  Math.random() * canvas.width,
    y: -20 - Math.random() * 180,
    vx: (Math.random() - 0.5) * 7,
    vy:  3 + Math.random() * 5,
    g:   0.13,
    col: cols[Math.floor(Math.random() * cols.length)],
    w:   7 + Math.random() * 7,
    h:  10 + Math.random() * 8,
    rot: Math.random() * 360,
    rv: (Math.random() - 0.5) * 14,
  }));
  function draw() {
    ctx2.clearRect(0, 0, canvas.width, canvas.height);
    let any = false;
    pieces.forEach(p => {
      p.x += p.vx; p.y += p.vy; p.vy += p.g; p.rot += p.rv;
      if (p.y < canvas.height + 40) any = true;
      ctx2.save();
      ctx2.translate(p.x, p.y);
      ctx2.rotate(p.rot * Math.PI / 180);
      ctx2.fillStyle = p.col;
      ctx2.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      ctx2.restore();
    });
    if (any) requestAnimationFrame(draw); else canvas.remove();
  }
  draw();
}

// Floating mute button — appended after each screen render
function _appendMuteBtn() {
  const btn = document.createElement('button');
  btn.title = 'Toggle music';
  btn.textContent = _muted ? '🔇' : '🔊';
  btn.style.cssText = 'position:fixed;bottom:16px;right:16px;background:rgba(255,255,255,0.13);' +
    'border:none;border-radius:50%;width:38px;height:38px;font-size:17px;' +
    'cursor:pointer;z-index:999;display:flex;align-items:center;justify-content:center;' +
    'transition:background 0.15s;';
  btn.addEventListener('mouseenter', () => { btn.style.background = 'rgba(255,255,255,0.25)'; });
  btn.addEventListener('mouseleave', () => { btn.style.background = 'rgba(255,255,255,0.13)'; });
  btn.addEventListener('click', () => { btn.textContent = toggleMute() ? '🔇' : '🔊'; });
  app.appendChild(btn);
}

// ── Message handlers ───────────────────────────────────────────────────────
function onMessage(msg) {
  switch (msg.type) {
    case 'player_list':
      S.players      = msg.players || [];
      S.playerCount  = msg.count || S.players.length;
      S.totalPlayers = S.playerCount;
      if (S.phase === 'lobby') updateLobbyPlayerList();
      break;

    case 'answer_count':
      S.answeredCount = msg.count;
      S.totalPlayers  = msg.total;
      if (S.phase === 'question') updateAnsweredTicker();
      break;

    // All game-flow transitions are server-authoritative.
    // The host sends 'next' / 'begin_timer' and waits for the broadcast here.
    case 'reveal':
      S.revealData = msg;
      if (S.phase === 'question') setPhase('reveal');
      break;

    case 'leaderboard':
      if (S.phase === 'reveal') {
        S.leaderboard = msg.leaderboard || [];
        S.qIndex      = msg.questionIndex + 1;
        S.qTotal      = msg.totalQuestions;
        setPhase('leaderboard');
      }
      break;

    case 'pre_question':
      if (S.phase === 'leaderboard') {
        S.qIndex      = msg.index + 1;
        S.qTotal      = msg.total;
        S.currentQ    = msg.question;
        S.answeredCount = 0;
        setPhase('pre_question');
      }
      break;

    case 'game_over':
      if (S.phase === 'leaderboard') {
        S.leaderboard      = msg.leaderboard      || [];
        S.playerAnswers    = msg.playerAnswers     || {};
        S.questionCorrects = (msg.questions || []).map(q => q.correct);
        setPhase('final');
      }
      break;
  }
}

// ── Phase transitions ──────────────────────────────────────────────────────
function setPhase(phase) {
  S.phase = phase;
  renderScreen();
  // Music hooks (question music is started by doStartTimerOnce, not here)
  if      (phase === 'lobby')   startLobbyMusic();
  else if (phase === 'reveal')  { stopMusic(); playRevealStinger(); }
  else if (phase === 'final')   startPodiumMusic();
  else if (phase !== 'question') stopMusic();
}

// ── Timer ──────────────────────────────────────────────────────────────────
function startCountdown(durationSecs) {
  if (S.timerInterval) clearInterval(S.timerInterval);
  _host5sWarned = false;
  const endTime = S.questionStart + durationSecs * 1000;

  function tick() {
    const remaining = Math.max(0, Math.ceil((endTime - Date.now()) / 1000));
    const pct       = Math.max(0, (endTime - Date.now()) / (durationSecs * 1000));

    updateTimerDisplay(remaining, pct);

    if (remaining <= 0) {
      clearInterval(S.timerInterval);
      S.timerInterval = null;
    }
  }
  tick();
  S.timerInterval = setInterval(tick, 250);
}

function stopCountdown() {
  if (S.timerInterval) { clearInterval(S.timerInterval); S.timerInterval = null; }
}

function updateTimerDisplay(remaining, pct) {
  const numEl  = document.getElementById('timer-num');
  const circEl = document.getElementById('timer-arc');
  if (numEl) numEl.textContent = remaining;
  if (circEl) {
    const r         = 54;
    const circ      = 2 * Math.PI * r;
    const dashOffset = circ * (1 - pct);
    circEl.style.strokeDashoffset = dashOffset;
    circEl.style.stroke = remaining <= 5 ? C.red : C.orange;
  }
  // 5-second audio warning (plays once per question)
  if (remaining === 5 && !_host5sWarned) {
    _host5sWarned = true;
    _once([[N.G5, 0.12], [N.F5, 0.12], [N.C5, 0.22]], 220, 'triangle', 0.14); // descending G-F-C stinger
  }
}

function updateAnsweredTicker() {
  const el  = document.getElementById('answered-count');
  const bar = document.getElementById('answered-bar');
  const pct = S.totalPlayers ? Math.round((S.answeredCount / S.totalPlayers) * 100) : 0;
  if (el)  el.textContent  = `${S.answeredCount} of ${S.totalPlayers} answered`;
  if (bar) bar.style.width = pct + '%';
}

function updateLobbyPlayerList() {
  const el   = document.getElementById('player-grid');
  const ct   = document.getElementById('player-count');
  const ctBig = document.getElementById('player-count-big');
  if (ct)    ct.textContent    = S.playerCount;
  if (ctBig) ctBig.textContent = S.playerCount;

  // Enable / disable the start button
  const startBtn = document.getElementById('start-btn');
  if (startBtn) {
    const enabled = S.playerCount >= 1;
    startBtn.disabled           = !enabled;
    startBtn.style.opacity      = enabled ? '1' : '0.5';
    startBtn.style.pointerEvents = enabled ? 'auto' : 'none';
  }

  if (!el) return;

  const palette = [C.red, C.blue, C.gold, C.lime, C.orange, C.dark];
  el.innerHTML = S.players.map((p, i) => `
    <div style="display:inline-flex;align-items:center;gap:8px;padding:6px 12px 6px 6px;
                background:rgba(255,255,255,0.08);font-size:15px;font-weight:700">
      <div style="width:26px;height:26px;border-radius:50%;background:${palette[i%palette.length]};
                  display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:900;color:#fff;flex-shrink:0">
        ${escHtml(p.name.trim()[0]?.toUpperCase() || '?')}
      </div>
      ${escHtml(p.name)}
    </div>`).join('');
}

// ── SVG shapes ─────────────────────────────────────────────────────────────
function shapeSVG(shape, size, color) {
  const p = `fill="${color}"`;
  if (shape === 'triangle') return `<svg width="${size}" height="${size}" viewBox="0 0 40 40"><polygon points="20,3 38,37 2,37" ${p}/></svg>`;
  if (shape === 'diamond')  return `<svg width="${size}" height="${size}" viewBox="0 0 40 40"><polygon points="20,2 38,20 20,38 2,20" ${p}/></svg>`;
  if (shape === 'circle')   return `<svg width="${size}" height="${size}" viewBox="0 0 40 40"><circle cx="20" cy="20" r="17" ${p}/></svg>`;
  return                           `<svg width="${size}" height="${size}" viewBox="0 0 40 40"><rect x="3" y="3" width="34" height="34" rx="2" ${p}/></svg>`;
}

// Shared WMG lockup
const MARK_DARK = `
  <div style="display:inline-flex;align-items:center;gap:10px">
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:3px">
      <div style="width:13px;height:13px;background:${C.red};clip-path:polygon(50% 0%,100% 100%,0% 100%)"></div>
      <div style="width:13px;height:13px;background:${C.blue};transform:rotate(45deg)"></div>
      <div style="width:13px;height:13px;background:${C.gold};border-radius:50%"></div>
      <div style="width:13px;height:13px;background:${C.lime}"></div>
    </div>
    <div style="line-height:1">
      <div style="font-weight:900;font-size:22px;color:#fff;letter-spacing:-0.5px">WMG Quiz</div>
      <div style="font-weight:700;font-size:8px;color:rgba(255,255,255,0.5);letter-spacing:2px;text-transform:uppercase">University of Warwick</div>
    </div>
  </div>`;

const MARK_LIGHT = `
  <div style="display:inline-flex;align-items:center;gap:12px">
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px">
      <div style="width:17px;height:17px;background:${C.red};clip-path:polygon(50% 0%,100% 100%,0% 100%)"></div>
      <div style="width:17px;height:17px;background:${C.blue};transform:rotate(45deg)"></div>
      <div style="width:17px;height:17px;background:${C.gold};border-radius:50%"></div>
      <div style="width:17px;height:17px;background:${C.lime}"></div>
    </div>
    <div style="line-height:1">
      <div style="font-weight:900;font-size:26px;color:${C.ink};letter-spacing:-0.5px">WMG Quiz</div>
      <div style="font-weight:700;font-size:9px;color:${C.grey};letter-spacing:2px;text-transform:uppercase">University of Warwick</div>
    </div>
  </div>`;

// Angular accent line
const ACCENT_LINE = `<svg width="88" height="10" viewBox="0 0 88 10" style="display:block;margin-bottom:14px">
  <polyline points="0,9 26,9 35,1 88,1" fill="none" stroke="${C.orange}" stroke-width="3" stroke-linecap="square"/>
</svg>`;

// Sector bar (burnt orange strip top-right)
const SECTOR_BAR = `<div style="position:absolute;top:0;right:0;height:6px;width:40%;background:${C.orange}"></div>`;

// Mini game header bar
function miniHeader(dark = true) {
  const subdued = dark ? 'rgba(255,255,255,0.5)' : C.grey;
  const fg      = dark ? '#fff' : C.ink;
  return `
  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:28px">
    <div style="display:flex;align-items:center;gap:18px">
      ${dark ? MARK_DARK : MARK_LIGHT}
      <div style="width:1px;height:26px;background:${subdued}"></div>
      <div style="font-weight:700;font-size:13px;letter-spacing:2px;text-transform:uppercase;color:${subdued}">
        ${escHtml(S.quizTitle)}
      </div>
    </div>
    <div style="font-weight:800;font-size:14px;color:${subdued};letter-spacing:1.5px;text-transform:uppercase;font-variant-numeric:tabular-nums">
      Question ${S.qIndex} / ${S.qTotal}
    </div>
  </div>`;
}

// ── Screen renderers ───────────────────────────────────────────────────────
const app = document.getElementById('app');

function renderScreen() {
  switch (S.phase) {
    case 'setup':        app.innerHTML = htmlSetup();        bindSetup();       break;
    case 'lobby':        app.innerHTML = htmlLobby();        bindLobby();       break;
    case 'pre_question': app.innerHTML = htmlPreQuestion();  bindPreQuestion(); break;
    case 'question':     app.innerHTML = htmlQuestion();     bindQuestion();    break;
    case 'reveal':       app.innerHTML = htmlReveal();       bindReveal();      break;
    case 'leaderboard':  app.innerHTML = htmlLeaderboard();  bindLeaderboard(); break;
    case 'final':        app.innerHTML = htmlFinal();        bindFinal();       break;
  }
  if (S.phase !== 'setup') _appendMuteBtn();
}

// ── 1. Setup ───────────────────────────────────────────────────────────────
function htmlSetup() {
  const placeholderJSON = `{
  "title": "WMG Quiz — Week 4",
  "defaultTime": 30,
  "questions": [
    {
      "q": "What is the primary purpose of a sprint retrospective?",
      "answers": [
        "To plan the next sprint's work",
        "To inspect and adapt the team's process",
        "To demonstrate completed features",
        "To groom the product backlog"
      ],
      "correct": 1,
      "time": 30
    }
  ]
}`;

  return `
<style>
  #su-wrap { padding:56px }
  #su-grid { display:grid; grid-template-columns:1.5fr 1fr; gap:36px; flex:1; min-height:0 }
  @media (max-width:860px) {
    #su-wrap { padding:32px }
    #su-grid { grid-template-columns:1fr }
  }
  @media (max-width:520px) {
    #su-wrap { padding:20px }
  }
</style>
<div id="su-wrap" style="min-height:100vh;background:${C.chalk};color:${C.ink};font-family:Lato,sans-serif;box-sizing:border-box;display:flex;flex-direction:column;position:relative;overflow:auto">
  <div style="position:absolute;top:0;right:0;height:6px;width:40%;background:${C.orange}"></div>

  <!-- Header -->
  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:36px;flex-wrap:wrap;gap:12px">
    ${MARK_LIGHT}
    <div style="display:flex;align-items:center;gap:8px;color:${C.grey};font-size:13px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase">
      <svg width="8" height="8" viewBox="0 0 10 10"><polygon points="0,2 10,5 0,8" fill="${C.orange}"/></svg>
      Host · Set up game
    </div>
  </div>

  <!-- Title block -->
  <div style="margin-bottom:36px">
    ${ACCENT_LINE}
    <div style="font-size:clamp(28px,5vw,52px);font-weight:900;line-height:1.0;letter-spacing:-1.5px">Start a new game.</div>
    <div style="font-size:clamp(14px,2vw,18px);font-weight:400;color:${C.inkSoft};margin-top:10px;max-width:640px">
      Paste or upload a question bank. Students join with a QR code or room name.
    </div>
  </div>

  <!-- Two-column body (stacks on small screens) -->
  <div id="su-grid">

    <!-- Left: JSON editor -->
    <div style="display:flex;flex-direction:column;gap:12px">
      <div style="display:flex;align-items:center;justify-content:space-between">
        <div style="font-size:12px;font-weight:800;letter-spacing:2px;text-transform:uppercase;color:${C.inkSoft}">Question bank</div>
        <div style="display:flex;gap:8px">
          <label style="display:inline-flex;align-items:center;gap:6px;padding:8px 14px;border:2px solid ${C.dark};background:#fff;font-size:13px;font-weight:800;text-transform:uppercase;letter-spacing:0.5px;cursor:pointer">
            📁 Upload JSON
            <input type="file" id="file-upload" accept=".json" style="display:none">
          </label>
        </div>
      </div>
      <textarea id="json-input" spellcheck="false" placeholder="${escHtml(placeholderJSON)}"
        style="flex:1;min-height:260px;background:#fff;border:2px solid ${C.dark};padding:20px 24px;
               font-family:'SF Mono',Menlo,monospace;font-size:12px;line-height:1.55;color:${C.inkSoft};
               resize:none;outline:none;box-sizing:border-box;-webkit-appearance:none"></textarea>
      <div id="json-status" style="font-size:13px;color:${C.grey};display:flex;align-items:center;gap:8px;min-height:20px"></div>
    </div>

    <!-- Right: Game settings -->
    <div style="display:flex;flex-direction:column;gap:20px">
      <div style="font-size:12px;font-weight:800;letter-spacing:2px;text-transform:uppercase;color:${C.inkSoft}">Game settings</div>

      <!-- Room name -->
      <div>
        <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:8px">
          <div style="font-size:13px;font-weight:800;color:${C.ink}">Room name</div>
          <div style="font-size:11px;color:${C.grey}">Used in the join URL</div>
        </div>
        <div style="display:flex;align-items:center;border:2px solid ${C.dark};background:#fff">
          <input id="room-input" value="${randomRoom()}"
            style="border:none;outline:none;flex:1;padding:14px 16px;font-family:Lato,sans-serif;font-size:18px;font-weight:800;color:${C.ink};background:transparent;-webkit-appearance:none">
          <button id="room-refresh" title="Generate new room name"
            style="border:none;background:transparent;cursor:pointer;padding:0 14px;height:50px;font-size:18px;color:${C.inkSoft}">↻</button>
        </div>
      </div>

      <!-- Default time -->
      <div>
        <div style="font-size:13px;font-weight:800;color:${C.ink};margin-bottom:8px">Default time per question</div>
        <div style="display:flex;gap:8px">
          ${[15, 20, 30, 45, 60].map(s => `
          <button class="time-btn" data-secs="${s}"
            style="flex:1;text-align:center;padding:12px 0;border:2px solid ${C.dark};
                   background:${s === 30 ? C.dark : '#fff'};color:${s === 30 ? '#fff' : C.ink};
                   font-family:Lato,sans-serif;font-size:15px;font-weight:800;cursor:pointer">${s}s</button>`).join('')}
        </div>
      </div>

      <!-- Scoring mode -->
      <div>
        <div style="font-size:13px;font-weight:800;color:${C.ink};margin-bottom:8px">Scoring</div>
        <div style="display:flex;gap:8px">
          <button class="score-btn" data-flat="0"
            style="flex:1;text-align:center;padding:12px 0;border:2px solid ${C.dark};
                   background:${C.dark};color:#fff;font-family:Lato,sans-serif;font-size:13px;font-weight:800;cursor:pointer">Speed-based</button>
          <button class="score-btn" data-flat="1"
            style="flex:1;text-align:center;padding:12px 0;border:2px solid ${C.dark};
                   background:#fff;color:${C.ink};font-family:Lato,sans-serif;font-size:13px;font-weight:800;cursor:pointer">Flat 1000 pts</button>
        </div>
      </div>

      <div style="flex:1"></div>

      <button id="create-btn"
        style="width:100%;padding:22px;background:${C.orange};color:#fff;font-family:Lato,sans-serif;
               font-size:20px;font-weight:800;text-transform:uppercase;letter-spacing:0.3px;border:none;cursor:pointer;
               opacity:0.5;pointer-events:none" disabled>
        Create game →
      </button>
      <div id="setup-error" style="display:none;padding:10px 14px;background:rgba(238,49,36,0.1);color:${C.red};font-size:13px;font-weight:700"></div>
    </div>
  </div>
</div>`;
}

function bindSetup() {
  const jsonInput  = document.getElementById('json-input');
  const fileUpload = document.getElementById('file-upload');
  const roomInput  = document.getElementById('room-input');
  const roomRefresh = document.getElementById('room-refresh');
  const createBtn  = document.getElementById('create-btn');
  const statusEl   = document.getElementById('json-status');
  const errorEl    = document.getElementById('setup-error');

  let parsedData = null;
  let defaultSecs = 30;
  let flatScoring = false;

  // Load default questions
  fetch('questions/default.json')
    .then(r => r.ok ? r.json() : null)
    .then(data => {
      if (data) {
        jsonInput.value = JSON.stringify(data, null, 2);
        validateJSON(jsonInput.value);
      }
    }).catch(() => {});

  // Time buttons
  document.querySelectorAll('.time-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      defaultSecs = parseInt(btn.dataset.secs, 10);
      document.querySelectorAll('.time-btn').forEach(b => {
        b.style.background = b === btn ? C.dark : '#fff';
        b.style.color      = b === btn ? '#fff' : C.ink;
      });
    });
  });

  // Scoring buttons
  document.querySelectorAll('.score-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      flatScoring = btn.dataset.flat === '1';
      document.querySelectorAll('.score-btn').forEach(b => {
        b.style.background = b === btn ? C.dark : '#fff';
        b.style.color      = b === btn ? '#fff' : C.ink;
      });
    });
  });

  // Room name refresh
  roomRefresh.addEventListener('click', () => { roomInput.value = randomRoom(); });

  // JSON validation
  function validateJSON(text) {
    if (!text.trim()) { setStatus(''); parsedData = null; setCreateEnabled(false); return; }
    try {
      const d = JSON.parse(text);
      if (!Array.isArray(d.questions) || d.questions.length === 0) throw new Error('No questions found');
      parsedData = d;
      setStatus(`<span style="color:${C.lime};font-weight:900">●</span> Loaded · <b style="color:${C.ink}">${d.questions.length} question${d.questions.length === 1 ? '' : 's'}</b>${d.title ? ` · ${escHtml(d.title)}` : ''}`);
      setCreateEnabled(true);
    } catch(e) {
      setStatus(`<span style="color:${C.red};font-weight:900">●</span> Invalid JSON: ${escHtml(e.message)}`);
      parsedData = null;
      setCreateEnabled(false);
    }
  }

  function setStatus(html) { statusEl.innerHTML = html; }
  function setCreateEnabled(on) {
    createBtn.disabled      = !on;
    createBtn.style.opacity = on ? '1' : '0.5';
    createBtn.style.pointerEvents = on ? 'auto' : 'none';
  }

  jsonInput.addEventListener('input', () => validateJSON(jsonInput.value));

  // File upload
  fileUpload.addEventListener('change', () => {
    const file = fileUpload.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = e => { jsonInput.value = e.target.result; validateJSON(e.target.result); };
    reader.readAsText(file);
  });

  // Create game
  createBtn.addEventListener('click', () => {
    errorEl.style.display = 'none';
    if (!parsedData) return;

    const room = roomInput.value.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
    if (!room) { errorEl.textContent = 'Please enter a valid room name.'; errorEl.style.display = 'block'; return; }

    S.room        = room;
    S.questions   = parsedData.questions;
    S.quizTitle   = parsedData.title || 'WMG Quiz';
    S.defaultTime = defaultSecs; // UI selection always wins over JSON's defaultTime
    S.flatScoring = flatScoring;
    S.qTotal      = parsedData.questions.length;

    connect(room);
    setPhase('lobby');

    // Generate the QR code — retry until qrcode.js CDN has loaded.
    // Give up after ~3 s (15 × 200 ms) and show a plain-text fallback.
    let qrTries = 0;
    const tryQR = () => {
      if (window.QRCode) {
        renderQR();
      } else if (qrTries++ < 15) {
        setTimeout(tryQR, 200);
      } else {
        // CDN didn't load — show join URL as text so the host can still announce it
        const canvas = document.getElementById('qr-canvas');
        if (canvas) {
          const base    = window.location.href.replace(/[^/]*$/, '');
          const joinURL = `${base}play.html?room=${encodeURIComponent(S.room)}`;
          canvas.outerHTML = `
            <div style="width:220px;padding:16px 18px;background:#fff;border:2px solid ${C.dark};
                        font-family:Lato,sans-serif;font-size:11px;font-weight:700;color:${C.ink};line-height:1.5;word-break:break-all">
              <div style="font-size:10px;letter-spacing:1.5px;text-transform:uppercase;color:${C.grey};margin-bottom:8px">QR unavailable — join at:</div>
              ${joinURL}
            </div>`;
        }
      }
    };
    setTimeout(tryQR, 80);
  });
}

// ── 2. Lobby ───────────────────────────────────────────────────────────────
function htmlLobby() {
  const joinURL = `${window.location.origin}${window.location.pathname.replace('index.html', '')}play.html?room=${encodeURIComponent(S.room)}`;

  return `
<style>
  #lb-wrap { padding:56px; overflow:hidden }
  #lb-grid { display:grid; grid-template-columns:1.4fr 1fr; gap:48px; flex:1; min-height:0 }
  #lb-right { border-left:1px solid rgba(255,255,255,0.12); padding-left:36px }
  @media (max-width:860px) {
    #lb-wrap { padding:32px; overflow:auto }
    #lb-grid { grid-template-columns:1fr; gap:28px }
    #lb-right { border-left:none; padding-left:0; border-top:1px solid rgba(255,255,255,0.12); padding-top:24px }
  }
  @media (max-width:520px) {
    #lb-wrap { padding:20px }
  }
</style>
<div id="lb-wrap" style="height:100vh;background:${C.dark};color:#fff;font-family:Lato,sans-serif;box-sizing:border-box;display:flex;flex-direction:column;position:relative">
  ${SECTOR_BAR}

  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:28px;flex-wrap:wrap;gap:10px">
    ${MARK_DARK}
    <div style="color:rgba(255,255,255,0.55);font-size:13px;font-weight:700;letter-spacing:2px;text-transform:uppercase">
      ${escHtml(S.quizTitle)}
    </div>
  </div>

  <div id="lb-grid">

    <!-- Left: join instructions + QR -->
    <div style="display:flex;flex-direction:column">
      <div style="font-size:16px;font-weight:800;letter-spacing:2px;text-transform:uppercase;color:${C.orange};margin-bottom:14px">Join the game</div>

      <div style="display:flex;gap:36px;align-items:flex-start;margin-bottom:auto;flex-wrap:wrap">
        <!-- QR code -->
        <div style="flex-shrink:0">
          <canvas id="qr-canvas" style="display:block"></canvas>
        </div>

        <!-- Room name + URL -->
        <div style="flex:1;padding-top:4px">
          <div style="font-size:13px;color:rgba(255,255,255,0.5);font-weight:700;letter-spacing:1.5px;text-transform:uppercase;margin-bottom:4px">① Go to</div>
          <div style="font-size:22px;font-weight:800;margin-bottom:20px;font-family:monospace;letter-spacing:-0.3px;word-break:break-all">
            ${window.location.href.replace(/[^/]*$/, 'play.html')}
          </div>
          <div style="font-size:13px;color:rgba(255,255,255,0.5);font-weight:700;letter-spacing:1.5px;text-transform:uppercase;margin-bottom:6px">② Enter room</div>
          <div style="display:inline-block;background:${C.orange};color:#fff;font-weight:900;font-size:48px;padding:8px 22px;letter-spacing:-2px;line-height:1;max-width:100%;word-break:break-all">
            ${escHtml(S.room)}
          </div>
        </div>
      </div>

      <div style="display:flex;align-items:center;gap:16px;margin-top:32px">
        <div style="flex:1"></div>
        <div style="font-size:13px;color:rgba(255,255,255,0.55);font-weight:700;margin-right:6px">
          <span id="player-count" style="font-variant-numeric:tabular-nums">0</span> ready
        </div>
        <button id="start-btn"
          style="padding:16px 28px;background:${C.orange};color:#fff;font-family:Lato,sans-serif;font-size:17px;font-weight:800;text-transform:uppercase;border:none;cursor:pointer;opacity:0.5;pointer-events:none" disabled>
          Start game →
        </button>
      </div>
    </div>

    <!-- Right: players list (border/padding managed by #lb-right media query) -->
    <div id="lb-right" style="display:flex;flex-direction:column;min-height:0;overflow:hidden">
      <div style="display:flex;align-items:baseline;justify-content:space-between;margin-bottom:16px;flex-shrink:0">
        <div style="font-size:16px;font-weight:800;letter-spacing:2px;text-transform:uppercase">Players in</div>
        <div id="player-count-big" style="font-size:36px;font-weight:900;color:${C.lime};font-variant-numeric:tabular-nums">0</div>
      </div>
      <div id="player-grid" style="display:flex;flex-wrap:wrap;gap:8px;align-content:flex-start;overflow:auto;flex:1"></div>
    </div>
  </div>
</div>`;
}

function bindLobby() {
  const startBtn = document.getElementById('start-btn');

  // Render any players who joined before the lobby rendered
  if (S.playerCount > 0) updateLobbyPlayerList();

  startBtn.addEventListener('click', () => {
    send({
      type:        'start',
      questions:   S.questions,
      title:       S.quizTitle,
      defaultTime: S.defaultTime,
      flatScoring: S.flatScoring,
    });
    S.qIndex  = 1;
    S.currentQ = S.questions[0];
    setPhase('pre_question');
  });
}

function renderQR() {
  const canvas = document.getElementById('qr-canvas');
  if (!canvas) return;
  if (!window.QRCode) { setTimeout(renderQR, 200); return; }

  // Derive the join URL relative to where index.html is hosted
  const base    = window.location.href.replace(/[^/]*$/, '');
  const joinURL = `${base}play.html?room=${encodeURIComponent(S.room)}`;

  QRCode.toCanvas(canvas, joinURL, {
    width:  220,
    margin: 2,
    color:  { dark: '#000000', light: '#FFFFFF' },
  }, err => { if (err) console.error('[QR]', err); });
}

// ── 3. Pre-question ────────────────────────────────────────────────────────
function htmlPreQuestion() {
  const q = S.currentQ;
  return `
<div style="height:100vh;background:${C.dark};color:#fff;font-family:Lato,sans-serif;padding:48px 56px;box-sizing:border-box;display:flex;flex-direction:column;position:relative;overflow:hidden">
  ${SECTOR_BAR}
  ${miniHeader(true)}

  <!-- Phase badge -->
  <div style="position:absolute;top:48px;right:56px">
    <div style="background:rgba(255,255,255,0.08);padding:6px 14px;font-size:12px;font-weight:800;letter-spacing:1.5px;text-transform:uppercase;color:${C.orange};display:flex;align-items:center;gap:8px">
      <span style="width:8px;height:8px;background:${C.orange};border-radius:50%;display:inline-block"></span>
      Read time
    </div>
  </div>

  <!-- Question centred -->
  <div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;gap:32px">
    <div>
      <svg width="120" height="14" viewBox="0 0 120 14" style="display:block;margin:0 auto 16px">
        <polyline points="0,13 36,13 48,1 120,1" fill="none" stroke="${C.orange}" stroke-width="4" stroke-linecap="square"/>
      </svg>
      <div style="font-size:20px;font-weight:700;color:${C.orange};letter-spacing:3px;text-transform:uppercase">Read the question</div>
    </div>
    <div style="font-size:60px;font-weight:900;line-height:1.1;letter-spacing:-1.5px;max-width:900px;text-wrap:balance">${escHtml(q.q)}</div>
    <div style="font-size:17px;color:rgba(255,255,255,0.55);max-width:560px">
      Take a moment — the timer starts when you're ready.
    </div>
  </div>

  <!-- Footer -->
  <div style="display:flex;align-items:center;gap:20px">
    <div style="flex:1;text-align:center;color:rgba(255,255,255,0.4);font-size:12px;font-weight:700;letter-spacing:2px;text-transform:uppercase">
      Press <kbd style="background:rgba(255,255,255,0.1);padding:2px 8px;color:#fff;font-family:monospace;letter-spacing:0">SPACE</kbd> to start the ${q.time || S.defaultTime}s timer
    </div>
    <button id="start-timer-btn"
      style="padding:16px 28px;background:${C.orange};color:#fff;font-family:Lato,sans-serif;font-size:17px;font-weight:800;text-transform:uppercase;border:none;cursor:pointer;flex-shrink:0">
      ▶ Start timer
    </button>
  </div>
</div>`;
}

function bindPreQuestion() {
  function doStartTimer() {
    send({ type: 'begin_timer' });
    S.questionStart = Date.now();
    S.answeredCount = 0;
    setPhase('question');
    startCountdown(S.currentQ.time || S.defaultTime);
  }

  let timerStarted = false;
  function doStartTimerOnce() {
    if (timerStarted) return;
    timerStarted = true;
    document.removeEventListener('keydown', onKey);
    startQuestionMusic();
    doStartTimer();
  }

  document.getElementById('start-timer-btn').addEventListener('click', doStartTimerOnce);

  function onKey(e) {
    if (e.key === ' ') { e.preventDefault(); doStartTimerOnce(); }
  }
  document.addEventListener('keydown', onKey);
}

// ── Shared tile-grid helpers ───────────────────────────────────────────────

/**
 * Renders the answer tiles for the host question screen.
 * Supports 2, 3, or 4 answers; 3rd option spans full width when count === 3.
 */
function hostAnswerTiles(q) {
  const count = q.answers.length;
  const rows  = count <= 2 ? '' : ';grid-template-rows:1fr 1fr';
  return `
  <div style="display:grid;grid-template-columns:1fr 1fr${rows};gap:14px;flex:1;min-height:0">
    ${TILES.slice(0, count).map((t, i) => `
    <div style="background:${t.color};padding:20px 24px;display:flex;align-items:center;gap:16px;overflow:hidden;${count === 3 && i === 2 ? 'grid-column:1/-1' : ''}">
      <div style="width:52px;height:52px;background:rgba(0,0,0,0.18);display:flex;align-items:center;justify-content:center;flex-shrink:0">
        ${shapeSVG(t.shape, 34, '#fff')}
      </div>
      <div style="font-family:Lato,sans-serif;font-weight:800;font-size:24px;line-height:1.15;color:#fff;text-wrap:balance">
        ${escHtml(q.answers[i] || '')}
      </div>
    </div>`).join('')}
  </div>`;
}

// ── 4. Question ────────────────────────────────────────────────────────────
function htmlQuestion() {
  const q   = S.currentQ;
  const dur = q?.time || S.defaultTime;
  const r   = 54;
  const circ = 2 * Math.PI * r;

  return `
<div style="height:100vh;background:${C.dark};color:#fff;font-family:Lato,sans-serif;padding:44px 52px;box-sizing:border-box;display:flex;flex-direction:column;position:relative;overflow:hidden">
  ${SECTOR_BAR}
  ${miniHeader(true)}

  <!-- Timer + question row -->
  <div style="display:flex;align-items:center;gap:36px;margin-bottom:24px">
    <!-- Circular timer -->
    <div style="position:relative;width:120px;height:120px;flex-shrink:0">
      <svg width="120" height="120" viewBox="0 0 120 120" style="position:absolute;inset:0;transform:rotate(-90deg)">
        <circle cx="60" cy="60" r="${r}" fill="none" stroke="rgba(255,255,255,0.1)" stroke-width="10"/>
        <circle id="timer-arc" cx="60" cy="60" r="${r}" fill="none" stroke="${C.orange}" stroke-width="10"
          stroke-dasharray="${circ}" stroke-dashoffset="0" stroke-linecap="round"
          style="transition:stroke-dashoffset 0.25s linear,stroke 0.5s"/>
      </svg>
      <div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;flex-direction:column">
        <div id="timer-num" style="font-size:44px;font-weight:900;font-variant-numeric:tabular-nums;line-height:1">${dur}</div>
        <div style="font-size:10px;font-weight:700;letter-spacing:1.5px;color:rgba(255,255,255,0.5)">SECONDS</div>
      </div>
    </div>
    <!-- Question text -->
    <div style="font-size:40px;font-weight:900;line-height:1.1;letter-spacing:-0.8px;flex:1;text-wrap:balance">${escHtml(q.q)}</div>
  </div>

  <!-- Answered progress bar -->
  <div style="height:5px;background:rgba(255,255,255,0.08);margin-bottom:20px;position:relative">
    <div id="answered-bar" style="position:absolute;inset:0;width:0%;background:${C.lime};transition:width 0.3s ease"></div>
  </div>
  <div id="answered-count" style="font-size:13px;font-weight:800;color:rgba(255,255,255,0.6);margin-bottom:20px;letter-spacing:0.5px">
    0 of ${S.totalPlayers} answered
  </div>

  <!-- Answer tiles — count driven by q.answers.length (2, 3, or 4) -->
  ${hostAnswerTiles(q)}

  <!-- Manual reveal button (bottom-right) -->
  <div style="display:flex;justify-content:flex-end;margin-top:18px">
    <button id="reveal-btn"
      style="padding:14px 24px;background:rgba(255,255,255,0.08);border:2px solid rgba(255,255,255,0.3);color:#fff;font-family:Lato,sans-serif;font-size:14px;font-weight:800;text-transform:uppercase;letter-spacing:1px;cursor:pointer">
      Reveal answers →
    </button>
  </div>
</div>`;
}

function bindQuestion() {
  const revealBtn = document.getElementById('reveal-btn');
  let confirmArmed = false;
  let confirmTimer = null;

  revealBtn.addEventListener('click', () => {
    if (!confirmArmed) {
      // First click — arm the confirm state for 3 s
      confirmArmed = true;
      revealBtn.textContent = '⚠ Click again to reveal';
      revealBtn.style.background = C.red;
      revealBtn.style.border = `2px solid ${C.red}`;
      revealBtn.style.color = '#fff';
      confirmTimer = setTimeout(() => {
        confirmArmed = false;
        revealBtn.textContent = 'Reveal answers →';
        revealBtn.style.background = 'rgba(255,255,255,0.08)';
        revealBtn.style.border = '2px solid rgba(255,255,255,0.3)';
        revealBtn.style.color = '#fff';
        confirmTimer = null;
      }, 3000);
    } else {
      // Second click — confirmed
      clearTimeout(confirmTimer);
      stopCountdown();
      send({ type: 'next' });
      app.innerHTML = `<div style="height:100vh;background:${C.dark};display:flex;align-items:center;justify-content:center;color:rgba(255,255,255,0.5);font-family:Lato,sans-serif;font-size:18px;font-weight:700;letter-spacing:1px">Calculating scores…</div>`;
    }
  });
}

// ── 5. Reveal ──────────────────────────────────────────────────────────────
function htmlReveal() {
  const data  = S.revealData;
  if (!data) return `<div style="height:100vh;background:${C.dark}"></div>`;

  const { correct, counts, question } = data;
  const maxC = Math.max(...counts, 1);

  return `
<div style="height:100vh;background:${C.dark};color:#fff;font-family:Lato,sans-serif;padding:44px 52px;box-sizing:border-box;display:flex;flex-direction:column;position:relative;overflow:hidden">
  ${SECTOR_BAR}
  ${miniHeader(true)}

  <!-- Phase badge -->
  <div style="position:absolute;top:44px;right:52px">
    <div style="background:${C.lime};color:${C.dark};padding:6px 14px;font-size:12px;font-weight:800;letter-spacing:1.5px;text-transform:uppercase">✓ Answer revealed</div>
  </div>

  <!-- Question -->
  <div style="margin-bottom:20px">
    <div style="font-size:13px;font-weight:800;letter-spacing:2px;text-transform:uppercase;color:rgba(255,255,255,0.5);margin-bottom:6px">Question</div>
    <div style="font-size:26px;font-weight:800;line-height:1.25">${escHtml(question.q)}</div>
  </div>

  <!-- Bar chart — N columns matching answer count -->
  <div style="display:grid;grid-template-columns:repeat(${question.answers.length},1fr);gap:14px;height:150px;align-items:end;margin-bottom:14px">
    ${counts.slice(0, question.answers.length).map((c, i) => {
      const h          = Math.round((c / maxC) * 100);
      const isCorrect  = i === correct;
      return `
      <div style="display:flex;flex-direction:column;align-items:center;justify-content:flex-end;height:100%">
        <div style="font-size:30px;font-weight:900;margin-bottom:4px;color:${isCorrect ? C.lime : '#fff'};font-variant-numeric:tabular-nums">${c}</div>
        <div style="width:70%;min-height:6px;height:${h}%;background:${TILES[i].color};${isCorrect ? `outline:3px solid ${C.lime};outline-offset:3px` : ''}"></div>
      </div>`;
    }).join('')}
  </div>

  <!-- Answer tiles — N across matching answer count -->
  <div style="display:grid;grid-template-columns:repeat(${question.answers.length},1fr);gap:14px;flex:1;min-height:0">
    ${question.answers.map((a, i) => {
      const isCorrect = i === correct;
      return `
      <div style="background:${TILES[i].color};padding:16px;opacity:${isCorrect ? 1 : 0.4};border:4px solid ${isCorrect ? C.lime : 'transparent'};display:flex;flex-direction:column;gap:10px">
        <div style="display:flex;align-items:center;gap:8px">
          ${shapeSVG(TILES[i].shape, 20, '#fff')}
          <div style="font-weight:800;font-size:12px;letter-spacing:1.5px;color:#fff">${TILES[i].letter}</div>
          ${isCorrect ? `<div style="margin-left:auto;background:${C.lime};color:${C.dark};font-weight:900;font-size:11px;padding:2px 8px;letter-spacing:1px">CORRECT</div>` : ''}
        </div>
        <div style="font-weight:800;font-size:15px;line-height:1.25;color:#fff">${escHtml(a)}</div>
      </div>`;
    }).join('')}
  </div>

  <div style="display:flex;align-items:center;gap:16px;margin-top:18px">
    <div style="flex:1"></div>
    <button id="show-lb-btn"
      style="padding:16px 28px;background:${C.orange};color:#fff;font-family:Lato,sans-serif;font-size:17px;font-weight:800;text-transform:uppercase;border:none;cursor:pointer">
      Show leaderboard →
    </button>
  </div>
</div>`;
}

function bindReveal() {
  document.getElementById('show-lb-btn').addEventListener('click', () => {
    send({ type: 'next' });
    // onMessage('leaderboard') will call setPhase('leaderboard').
  });
}

// ── 6. Leaderboard ─────────────────────────────────────────────────────────
function htmlLeaderboard() {
  const board   = S.leaderboard.slice(0, 5);
  const isLast  = S.qIndex >= S.qTotal;
  const palette = [C.red, C.blue, C.gold, C.lime, C.orange];

  return `
<style>
@keyframes rowIn { from { transform:translateX(80px);opacity:0 } to { transform:translateX(0);opacity:1 } }
</style>
<div style="height:100vh;background:${C.dark};color:#fff;font-family:Lato,sans-serif;padding:52px 56px;box-sizing:border-box;display:flex;flex-direction:column;position:relative;overflow:hidden">
  ${SECTOR_BAR}
  ${miniHeader(true)}

  <!-- Title -->
  <div style="margin-bottom:28px;display:flex;align-items:flex-end;justify-content:space-between">
    <div>
      ${ACCENT_LINE}
      <div style="font-size:52px;font-weight:900;line-height:1;letter-spacing:-1.5px;margin-top:8px">Leaderboard</div>
    </div>
    <div style="font-size:13px;color:rgba(255,255,255,0.5);font-weight:700;letter-spacing:1.5px;text-transform:uppercase">
      ${S.totalPlayers} players · ${S.qIndex} of ${S.qTotal} questions
    </div>
  </div>

  <!-- Top 5 rows — animate in from the right, staggered -->
  <div style="display:flex;flex-direction:column;gap:10px;flex:1;min-height:0">
    ${board.map((p, i) => {
      const isTop = i === 0;
      return `
      <div style="display:flex;align-items:center;gap:22px;padding:16px 22px;
                  background:${isTop ? C.orange : 'rgba(255,255,255,0.06)'};
                  border-left:${isTop ? 'none' : `4px solid ${TILES[i % 4].color}`};
                  animation:rowIn 0.45s cubic-bezier(0.2,0,0,1) both;
                  animation-delay:${i * 0.1}s">
        <div style="font-size:34px;font-weight:900;width:56px;font-variant-numeric:tabular-nums;line-height:1;color:${isTop ? '#fff' : 'rgba(255,255,255,0.4)'}">${p.rank}</div>
        <div style="width:44px;height:44px;border-radius:50%;background:${palette[i % palette.length]};
                    display:flex;align-items:center;justify-content:center;font-weight:900;font-size:18px;flex-shrink:0">
          ${escHtml(p.name.trim()[0]?.toUpperCase() || '?')}
        </div>
        <div style="flex:1;font-size:24px;font-weight:800">${escHtml(p.name)}</div>
        <div class="score-val" data-score="${p.score}"
             style="font-size:13px;font-weight:800;padding:4px 10px;
                    background:${isTop ? 'rgba(255,255,255,0.18)' : 'rgba(193,216,47,0.18)'};
                    color:${isTop ? '#fff' : C.lime};letter-spacing:0.5px">
          0 pts
        </div>
      </div>`;
    }).join('')}
  </div>

  <div style="display:flex;align-items:center;gap:16px;margin-top:20px">
    <div style="flex:1"></div>
    <button id="next-q-btn"
      style="padding:16px 28px;background:${C.orange};color:#fff;font-family:Lato,sans-serif;font-size:17px;font-weight:800;text-transform:uppercase;border:none;cursor:pointer">
      ${isLast ? 'Final results →' : 'Next question →'}
    </button>
  </div>
</div>`;
}

function bindLeaderboard() {
  document.getElementById('next-q-btn').addEventListener('click', () => {
    send({ type: 'next' });
    // onMessage('pre_question') or onMessage('game_over') will drive the transition.
  });

  // Count each score up from 0 → final value
  document.querySelectorAll('.score-val').forEach(el => {
    const target = parseInt(el.dataset.score, 10) || 0;
    if (!target) { el.textContent = '0 pts'; return; }
    let cur = 0;
    const step = Math.ceil(target / 28);
    const iv = setInterval(() => {
      cur = Math.min(cur + step, target);
      el.textContent = cur.toLocaleString() + ' pts';
      if (cur >= target) clearInterval(iv);
    }, 35);
  });
}

// ── 7. Final / Podium ──────────────────────────────────────────────────────
function htmlFinal() {
  const podium = S.leaderboard.slice(0, 3);
  // Visual order: left=2nd, centre=1st, right=3rd
  // Use podium array indices, not column position, to determine rank.
  const slots        = [1, 0, 2]; // podium[] index for each visual column
  const podiumHeights = ['62%', '88%', '48%'];
  const podiumColors  = [C.blue, C.orange, C.lime];

  // Dramatic reveal: 3rd rises first, then 2nd, then 1st
  // col 0 = left = 2nd place, col 1 = centre = 1st place, col 2 = right = 3rd place
  const podiumDelays = ['0.45s', '0.75s', '0.15s'];

  return `
<style>
@keyframes riseUp { from { transform:scaleY(0) } to { transform:scaleY(1) } }
</style>
<div style="height:100vh;background:${C.dark};color:#fff;font-family:Lato,sans-serif;padding:52px 56px;box-sizing:border-box;display:flex;flex-direction:column;position:relative;overflow:hidden">
  ${SECTOR_BAR}

  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
    ${MARK_DARK}
    <div style="color:rgba(255,255,255,0.55);font-size:13px;font-weight:700;letter-spacing:2px;text-transform:uppercase">
      Game over · ${S.qTotal} of ${S.qTotal} · ${S.totalPlayers} players
    </div>
  </div>

  <div style="text-align:center;margin-bottom:10px">
    <svg width="120" height="12" viewBox="0 0 120 12" style="display:block;margin:0 auto 14px">
      <polyline points="0,11 36,11 48,1 120,1" fill="none" stroke="${C.orange}" stroke-width="4" stroke-linecap="square"/>
    </svg>
    <div style="font-size:76px;font-weight:900;letter-spacing:-2px;line-height:1">Well played!</div>
    <div style="font-size:17px;color:rgba(255,255,255,0.5);margin-top:6px">${escHtml(S.quizTitle)}</div>
  </div>

  <!-- Podium — bars animate up from bottom (3rd → 2nd → 1st) -->
  <div style="flex:1;display:grid;grid-template-columns:1fr 1.1fr 1fr;align-items:end;gap:20px;padding:0 80px;min-height:0">
    ${slots.map((pidx, col) => {
      const p = podium[pidx];
      if (!p) return '<div></div>';
      const rank  = p.rank;   // from leaderboard data, not from column position
      const color = podiumColors[col];
      const h     = podiumHeights[col];
      const delay = podiumDelays[col];
      const ord   = rank === 1 ? 'st' : rank === 2 ? 'nd' : 'rd';
      return `
      <div style="display:flex;flex-direction:column;align-items:center;justify-content:flex-end;height:100%">
        ${rank === 1 ? `<div style="margin-bottom:6px">${shapeSVG('triangle', 28, C.gold)}</div>` : ''}
        <div style="width:60px;height:60px;border-radius:50%;background:${TILES[(rank-1)%4].color};
                    display:flex;align-items:center;justify-content:center;font-weight:900;font-size:24px">
          ${escHtml(p.name.trim()[0]?.toUpperCase() || '?')}
        </div>
        <div style="font-size:22px;font-weight:900;margin-top:8px">${escHtml(p.name)}</div>
        <div style="font-size:13px;font-weight:700;color:rgba(255,255,255,0.55);letter-spacing:0.5px;font-variant-numeric:tabular-nums">${p.score.toLocaleString()} pts</div>
        <div style="width:100%;height:${h};margin-top:12px;background:${color};
                    display:flex;align-items:flex-start;justify-content:center;padding-top:16px;
                    transform-origin:bottom;animation:riseUp 0.7s cubic-bezier(0.2,0,0,1) ${delay} both">
          <div style="font-size:72px;font-weight:900;color:#fff;line-height:1">${rank}</div>
        </div>
      </div>`;
    }).join('')}
  </div>

  <div style="display:flex;align-items:center;gap:14px;margin-top:20px">
    <button id="csv-btn"
      style="padding:14px 22px;background:transparent;color:rgba(255,255,255,0.7);border:2px solid rgba(255,255,255,0.3);
             font-family:Lato,sans-serif;font-size:14px;font-weight:800;text-transform:uppercase;cursor:pointer">
      ↓ Download results (CSV)
    </button>
    <div style="flex:1"></div>
    <button id="play-again-btn"
      style="padding:14px 22px;background:transparent;color:rgba(255,255,255,0.7);border:2px solid rgba(255,255,255,0.3);
             font-family:Lato,sans-serif;font-size:14px;font-weight:800;text-transform:uppercase;cursor:pointer">
      Play again
    </button>
    <button id="end-btn"
      style="padding:16px 28px;background:${C.orange};color:#fff;font-family:Lato,sans-serif;font-size:17px;font-weight:800;text-transform:uppercase;border:none;cursor:pointer">
      End game
    </button>
  </div>
</div>`;
}

function bindFinal() {
  launchConfetti();
  document.getElementById('csv-btn')?.addEventListener('click', downloadCSV);
  document.getElementById('play-again-btn')?.addEventListener('click', () => {
    window.location.reload();
  });
  document.getElementById('end-btn')?.addEventListener('click', () => {
    send({ type: 'end' });
    window.location.reload();
  });
}

function downloadCSV() {
  const qCount  = S.questionCorrects.length || S.questions.length;
  const corrects = S.questionCorrects; // may be empty if old server version

  // Build header row: Rank, Name, Score, Q1, Q2, …
  const headers = ['Rank', 'Name', 'Score'];
  for (let i = 0; i < qCount; i++) headers.push(`Q${i + 1}`);

  const rows = [headers];
  S.leaderboard.forEach(p => {
    const row      = [p.rank, p.name, p.score];
    const pAnswers = S.playerAnswers[p.name] || {};
    for (let i = 0; i < qCount; i++) {
      if (!(i in pAnswers)) {
        row.push('–');           // player didn't answer this question
      } else if (corrects.length > i) {
        row.push(pAnswers[i] === corrects[i] ? '✓' : '✗');
      } else {
        row.push(pAnswers[i]);   // fallback: just the raw answer index
      }
    }
    rows.push(row);
  });

  // Wrap each cell in quotes so commas/special chars are safe
  const csv  = rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }); // BOM for Excel
  const a    = document.createElement('a');
  a.href     = URL.createObjectURL(blob);
  a.download = `wmg-quiz-${S.room}-results.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ── Utilities ──────────────────────────────────────────────────────────────
const ADJECTIVES = ['swift','bright','bold','calm','keen','wise','warm','clear','cool','fine','pure','just'];
const ANIMALS    = ['otter','hawk','wolf','bear','lynx','crane','fox','owl','deer','heron','raven','finch'];

function randomRoom() {
  const a = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const b = ANIMALS[Math.floor(Math.random() * ANIMALS.length)];
  return `${a}-${b}`;
}

function escHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// ── Init ───────────────────────────────────────────────────────────────────
setPhase('setup');
