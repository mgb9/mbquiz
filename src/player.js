/**
 * player.js — WMG Quiz player view logic
 *
 * Manages the full state machine:
 *   join → waiting → pre_question → question → locked → reveal → (loop) → final
 *
 * Uses the native WebSocket API.  Persists session to localStorage so
 * students who lock their phone or switch apps can rejoin seamlessly.
 */

import { PARTYKIT_HOST } from './config.js';

// ── Design tokens ──────────────────────────────────────────────────────────
const C = {
  red:         '#EE3124',
  blue:        '#009DDC',
  gold:        '#FBB034',
  lime:        '#C1D82F',
  orange:      '#F47920',
  dark:        '#211F25',
  grey:        '#6D6E71',
  chalk:       '#FAFAF8',
  ink:         '#1A1820',
  inkSoft:     '#3A3641',
};

const TILES = [
  { letter: 'A', color: C.red,    shape: 'triangle', name: 'Red Triangle'  },
  { letter: 'B', color: C.blue,   shape: 'diamond',  name: 'Blue Diamond'  },
  { letter: 'C', color: C.gold,   shape: 'circle',   name: 'Gold Circle'   },
  { letter: 'D', color: C.lime,   shape: 'square',   name: 'Lime Square'   },
];

// ── State ──────────────────────────────────────────────────────────────────
const S = {
  phase:         'join',   // join|waiting|pre_question|question|locked|reveal|final
  nickname:      '',
  token:         '',
  room:          '',
  score:         0,
  currentQ:      null,     // { q, answers, time }
  qIndex:        0,
  qTotal:        0,
  questionStart: 0,        // server ms timestamp
  chosenAnswer:  null,
  roundScore:    0,
  rankPos:       0,
  rankChange:    0,
  totalPlayers:  0,
  answeredCount: 0,
  correct:       null,
  leaderboard:   [],
  preLB:         [],       // leaderboard snapshot before this round (for rank change)
};

// ── WebSocket ──────────────────────────────────────────────────────────────
let ws = null;
let timerInterval = null;
let reconnectTimeout = null;

function connect() {
  if (reconnectTimeout) { clearTimeout(reconnectTimeout); reconnectTimeout = null; }
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

  const url = `wss://${PARTYKIT_HOST}/party/${encodeURIComponent(S.room)}`;
  ws = new WebSocket(url);

  ws.addEventListener('open', () => {
    hideReconnectBanner();
    const stored = getSession(S.room);
    if (stored && stored.nickname === S.nickname && stored.token === S.token) {
      send({ type: 'rejoin', nickname: S.nickname, token: S.token });
    } else {
      send({ type: 'join', nickname: S.nickname, token: S.token });
    }
  });

  ws.addEventListener('message', e => {
    try { onMessage(JSON.parse(e.data)); } catch {}
  });

  ws.addEventListener('close', () => {
    if (S.phase !== 'join') {
      showReconnectBanner();
      reconnectTimeout = setTimeout(connect, 2000);
    }
  });

  ws.addEventListener('error', () => ws.close());
}

function send(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

// ── Player audio engine ────────────────────────────────────────────────────
// Minimal Web Audio API synth — same pattern as host.js, no external deps.

let _pActx = null;
let _warned5s = false;

function _pGetCtx() {
  if (!_pActx) {
    try { _pActx = new (window.AudioContext || window.webkitAudioContext)(); } catch { return null; }
  }
  if (_pActx.state === 'suspended') _pActx.resume().catch(() => {});
  return _pActx;
}

// Play a sequence of [freq, beats] once. freq=0 → rest.
function _pOnce(seq, bpm, wave, vol) {
  const ctx = _pGetCtx(); if (!ctx) return;
  const beat = 60 / bpm;
  let t = ctx.currentTime + 0.04;
  seq.forEach(([f, b]) => {
    const dur = b * beat;
    if (f) {
      const osc = ctx.createOscillator();
      const env = ctx.createGain();
      const att = Math.min(0.015, dur * 0.1);
      const rel = Math.min(0.1, dur * 0.4);
      osc.type = wave;
      osc.frequency.value = f;
      env.gain.setValueAtTime(0, t);
      env.gain.linearRampToValueAtTime(vol, t + att);
      env.gain.setValueAtTime(vol, t + dur - rel);
      env.gain.exponentialRampToValueAtTime(0.0001, t + dur - 0.005);
      osc.connect(env); env.connect(ctx.destination);
      osc.start(t); osc.stop(t + dur);
    }
    t += dur;
  });
}

// Sound effects
function playAnswerLock() { _pOnce([[784, 0.07]], 240, 'sine', 0.20); }         // G5 bip
function playCorrect()    { _pOnce([[523.3, 0.18],[659.3, 0.18],[784, 0.32]], 210, 'triangle', 0.18); } // C5-E5-G5
function playWrong()      { _pOnce([[220, 0.28]], 120, 'sawtooth', 0.12); }     // A3 thud
function play5sWarning()  { _pOnce([[784, 0.12],[698.5, 0.12],[523.3, 0.22]], 220, 'triangle', 0.13); } // G5-F5-C5 descending

// ── UI helpers ─────────────────────────────────────────────────────────────

// Reconnect banner — shown when WebSocket drops, removed on restore.
function showReconnectBanner() {
  if (document.getElementById('reconnect-banner')) return;
  const el = document.createElement('div');
  el.id = 'reconnect-banner';
  el.style.cssText = 'position:fixed;bottom:0;left:0;right:0;padding:10px 16px;' +
    'background:rgba(0,0,0,0.88);color:#fff;font-family:Lato,sans-serif;' +
    'font-size:12px;font-weight:800;text-align:center;letter-spacing:1.5px;' +
    'text-transform:uppercase;z-index:9999';
  el.textContent = '↻ Reconnecting…';
  document.body.appendChild(el);
}

function hideReconnectBanner() {
  document.getElementById('reconnect-banner')?.remove();
}

// "GO!" flash — shown when the host starts the timer, then fades out.
function showGoFlash(cb) {
  const flash = document.createElement('div');
  flash.style.cssText = 'position:fixed;inset:0;background:' + C.orange +
    ';display:flex;align-items:center;justify-content:center;z-index:9990;pointer-events:none;transition:opacity 0.2s';
  flash.innerHTML = '<div style="font-family:Lato,sans-serif;font-size:110px;font-weight:900;color:#fff;letter-spacing:-4px;line-height:1">GO!</div>';
  document.body.appendChild(flash);
  setTimeout(() => {
    flash.style.opacity = '0';
    setTimeout(() => { flash.remove(); cb(); }, 200);
  }, 480);
}

// ── Message handlers ───────────────────────────────────────────────────────
function onMessage(msg) {
  switch (msg.type) {

    case 'joined':
    case 'rejoined':
      S.nickname = msg.nickname;
      if (msg.score != null) S.score = msg.score;
      saveSession(S.room, S.nickname, S.token);
      if (S.phase === 'join' || msg.type === 'rejoined') {
        setPhase('waiting');
      }
      break;

    case 'rejoin_failed':
      clearSession(S.room);
      setPhase('join');
      break;

    case 'player_list':
      S.totalPlayers = msg.count || msg.players?.length || 0;
      if (S.phase === 'waiting') renderScreen();
      break;

    case 'pre_question':
      S.currentQ    = msg.question;
      S.qIndex      = msg.index + 1;
      S.qTotal      = msg.total;
      S.chosenAnswer = null; // reset from previous round
      stopTimer();
      // Save current leaderboard position before new round
      S.preLB = S.leaderboard.slice();
      setPhase('pre_question');
      break;

    case 'timer_started':
      S.currentQ      = msg.question;
      S.qIndex        = msg.index + 1;
      S.qTotal        = msg.total;
      S.questionStart = msg.questionStartTime;
      // Flash "GO!" then switch to question (mid-question rejoin skips the flash)
      if (S.phase === 'pre_question') {
        showGoFlash(() => {
          setPhase('question');
          startTimer(msg.questionStartTime, S.currentQ.time);
        });
      } else {
        setPhase('question');
        startTimer(msg.questionStartTime, S.currentQ.time);
      }
      break;

    case 'answer_received_late':
      S.currentQ      = msg.question;
      S.qIndex        = msg.index + 1;
      S.qTotal        = msg.total;
      S.questionStart = msg.questionStartTime;
      S.chosenAnswer  = msg.answerIndex;
      S.answeredCount = msg.answerCount || 0;
      S.totalPlayers  = msg.playerCount || 0;
      setPhase('locked');
      break;

    case 'answer_received':
      S.chosenAnswer = msg.answerIndex;
      setPhase('locked');
      break;

    case 'answer_count':
      S.answeredCount = msg.count;
      S.totalPlayers  = msg.total;
      if (S.phase === 'locked') {
        const bar = document.getElementById('answer-progress');
        const txt = document.getElementById('answer-count-txt');
        const pct = S.totalPlayers ? Math.round((S.answeredCount / S.totalPlayers) * 100) : 0;
        if (bar) bar.style.width = pct + '%';
        if (txt) txt.textContent = `${S.answeredCount} / ${S.totalPlayers}`;
      }
      break;

    case 'reveal': {
      stopTimer();
      S.correct = msg.correct;
      S.leaderboard = msg.leaderboard || [];
      const wasCorrect = S.chosenAnswer === msg.correct;
      S.roundScore = (msg.roundScores && msg.roundScores[S.nickname]) || 0;
      if (wasCorrect) S.score += S.roundScore;

      // Rank change
      const prevRank = findRank(S.preLB, S.nickname);
      const newRank  = findRank(S.leaderboard, S.nickname);
      S.rankPos    = newRank;
      S.rankChange = prevRank > 0 ? prevRank - newRank : 0; // positive = went up
      setPhase('reveal');
      break;
    }

    case 'leaderboard':
      // Intermediate leaderboard between rounds — player just stays on reveal/waiting
      S.leaderboard = msg.leaderboard || [];
      if (S.phase === 'reveal') {
        // Update rank quietly
        const r = findRank(S.leaderboard, S.nickname);
        if (r) S.rankPos = r;
        const el = document.getElementById('rank-num');
        if (el) el.textContent = S.rankPos;
      }
      break;

    case 'game_over':
      S.leaderboard = msg.leaderboard || [];
      S.rankPos = findRank(S.leaderboard, S.nickname);
      stopTimer();
      setPhase('final');
      break;
  }
}

// ── Timer ──────────────────────────────────────────────────────────────────
function startTimer(startTime, durationSecs) {
  stopTimer();
  _warned5s = false;
  const endTime = startTime + durationSecs * 1000;

  function tick() {
    const remaining = Math.max(0, Math.ceil((endTime - Date.now()) / 1000));
    const bar = document.getElementById('timer-bar');
    const txt = document.getElementById('timer-txt');
    const pct = Math.min(100, ((endTime - Date.now()) / (durationSecs * 1000)) * 100);

    if (bar) bar.style.width = Math.max(0, pct) + '%';
    if (txt) txt.textContent = remaining + 's';

    if (remaining <= 5) {
      if (txt) txt.style.color = C.red;
      if (!_warned5s) { _warned5s = true; play5sWarning(); }
    }

    if (remaining <= 0) {
      stopTimer();
      // Timer expired on player side — show "locked" if they haven't answered
      if (S.phase === 'question') {
        S.chosenAnswer = null;
        setPhase('locked');
      }
    }
  }

  tick();
  timerInterval = setInterval(tick, 250);
}

function stopTimer() {
  if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
}

// ── Phase management ───────────────────────────────────────────────────────
function setPhase(phase) {
  S.phase = phase;
  renderScreen();
}

// ── Screen rendering ───────────────────────────────────────────────────────
const app = document.getElementById('app');

function renderScreen() {
  switch (S.phase) {
    case 'join':         app.innerHTML = htmlJoin();         bindJoin();         break;
    case 'waiting':      app.innerHTML = htmlWaiting();                          break;
    case 'pre_question': app.innerHTML = htmlPreQuestion();                      break;
    case 'question':     app.innerHTML = htmlQuestion();     bindQuestion();      break;
    case 'locked':       app.innerHTML = htmlLocked();                           break;
    case 'reveal':       app.innerHTML = htmlReveal();  bindReveal();            break;
    case 'final':        app.innerHTML = htmlFinal();        bindFinal();         break;
  }
}

// ── SVG shapes ─────────────────────────────────────────────────────────────
function shapeSVG(shape, size, color) {
  const props = `fill="${color}"`;
  if (shape === 'triangle') return `<svg width="${size}" height="${size}" viewBox="0 0 40 40"><polygon points="20,3 38,37 2,37" ${props}/></svg>`;
  if (shape === 'diamond')  return `<svg width="${size}" height="${size}" viewBox="0 0 40 40"><polygon points="20,2 38,20 20,38 2,20" ${props}/></svg>`;
  if (shape === 'circle')   return `<svg width="${size}" height="${size}" viewBox="0 0 40 40"><circle cx="20" cy="20" r="17" ${props}/></svg>`;
  /* square */               return `<svg width="${size}" height="${size}" viewBox="0 0 40 40"><rect x="3" y="3" width="34" height="34" rx="2" ${props}/></svg>`;
}

// WMG Quiz lockup (compact)
const MARK_COMPACT = `
  <div style="display:inline-flex;align-items:center;gap:10px">
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:3px">
      <div style="width:11px;height:11px;background:${C.red};clip-path:polygon(50% 0%,100% 100%,0% 100%)"></div>
      <div style="width:11px;height:11px;background:${C.blue};transform:rotate(45deg)"></div>
      <div style="width:11px;height:11px;background:${C.gold};border-radius:50%"></div>
      <div style="width:11px;height:11px;background:${C.lime}"></div>
    </div>
  </div>`;

const MARK = `
  <div style="display:inline-flex;align-items:center;gap:12px">
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px">
      <div style="width:15px;height:15px;background:${C.red};clip-path:polygon(50% 0%,100% 100%,0% 100%)"></div>
      <div style="width:15px;height:15px;background:${C.blue};transform:rotate(45deg)"></div>
      <div style="width:15px;height:15px;background:${C.gold};border-radius:50%"></div>
      <div style="width:15px;height:15px;background:${C.lime}"></div>
    </div>
    <div style="line-height:1">
      <div style="font-weight:900;font-size:20px;color:${C.ink};letter-spacing:-0.5px">WMG Quiz</div>
      <div style="font-weight:700;font-size:9px;color:${C.grey};letter-spacing:2px;text-transform:uppercase">University of Warwick</div>
    </div>
  </div>`;

// Angular accent line
const ACCENT_LINE = `<svg width="64" height="8" viewBox="0 0 64 8" style="display:block;margin-bottom:12px">
  <polyline points="0,7 19,7 26,1 64,1" fill="none" stroke="${C.orange}" stroke-width="3" stroke-linecap="square"/>
</svg>`;

// ── Screen HTML ────────────────────────────────────────────────────────────

function htmlJoin() {
  const room = S.room || '';
  const stored = room ? getSession(room) : null;
  const nick = stored?.nickname || '';

  return `
<div style="height:100dvh;display:flex;flex-direction:column;background:${C.chalk};color:${C.ink};font-family:Lato,sans-serif;overflow:hidden">

  <!-- Header -->
  <div style="padding:24px 24px 0">${MARK}</div>

  <!-- Body -->
  <div style="flex:1;padding:28px 28px 24px;display:flex;flex-direction:column;overflow:auto">
    ${ACCENT_LINE}
    <div style="font-size:38px;font-weight:900;line-height:1.05;letter-spacing:-1px;margin-bottom:${room ? '10px' : '24px'}">Join<br>the game.</div>

    ${!room ? `
    <div style="margin-bottom:20px">
      <div style="font-size:11px;font-weight:800;letter-spacing:2px;text-transform:uppercase;color:${C.grey};margin-bottom:8px">Room name</div>
      <input id="room-input" value="${room}" placeholder="swift-otter"
        style="width:100%;padding:16px 18px;font-family:Lato,sans-serif;font-size:18px;font-weight:800;color:${C.ink};background:#fff;border:2px solid ${C.dark};border-radius:0;box-sizing:border-box;-webkit-appearance:none">
    </div>` : `
    <div style="display:inline-flex;align-items:center;gap:8px;margin-bottom:28px">
      <div style="background:${C.dark};color:#fff;font-family:monospace;font-weight:800;font-size:22px;padding:6px 14px;letter-spacing:-0.5px">${room}</div>
    </div>`}

    <div>
      <div style="font-size:11px;font-weight:800;letter-spacing:2px;text-transform:uppercase;color:${C.grey};margin-bottom:8px">Your nickname</div>
      <input id="nick-input" value="${nick}" placeholder="Enter nickname…" maxlength="32" autocomplete="off" autocorrect="off"
        style="width:100%;padding:16px 18px;font-family:Lato,sans-serif;font-size:20px;font-weight:800;color:${C.ink};background:#fff;border:2px solid ${C.dark};border-radius:0;box-sizing:border-box;-webkit-appearance:none">
      <div style="font-size:12px;color:${C.grey};margin-top:8px;display:flex;align-items:center;gap:6px">
        <svg width="8" height="8" viewBox="0 0 10 10"><polygon points="0,2 10,5 0,8" fill="${C.orange}"/></svg>
        Visible to classmates and on the projector.
      </div>
    </div>

    <div id="join-error" style="display:none;margin-top:12px;padding:10px 14px;background:rgba(238,49,36,0.1);color:${C.red};font-size:13px;font-weight:700"></div>

    <div style="flex:1;min-height:24px"></div>

    <button id="join-btn"
      style="width:100%;padding:20px;background:${C.orange};color:#fff;font-family:Lato,sans-serif;font-size:18px;font-weight:800;text-transform:uppercase;letter-spacing:0.3px;border:none;border-radius:0;cursor:pointer;-webkit-tap-highlight-color:transparent">
      Join game →
    </button>

    ${room ? `<div style="margin-top:16px;font-size:12px;color:${C.grey};text-align:center">
      Wrong room? <a href="play.html" style="color:${C.ink};font-weight:800;text-decoration:none;border-bottom:2px solid ${C.orange}">Scan QR again</a>
    </div>` : ''}
  </div>
</div>`;
}

function bindJoin() {
  const joinBtn   = document.getElementById('join-btn');
  const nickInput = document.getElementById('nick-input');
  const roomInput = document.getElementById('room-input');
  const errEl     = document.getElementById('join-error');

  function doJoin() {
    const nick = nickInput.value.trim();
    const room = roomInput ? roomInput.value.trim() : S.room;
    if (!nick) { showError('Please enter a nickname.'); nickInput.focus(); return; }
    if (!room) { showError('Please enter the room name.'); roomInput?.focus(); return; }

    S.nickname = nick;
    S.room     = room;
    S.token    = crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36);

    // Pre-create AudioContext while we have a user gesture so sounds work later
    _pGetCtx();

    // Optimistic waiting screen while connecting
    setPhase('waiting');
    connect();
  }

  function showError(msg) {
    errEl.textContent = msg;
    errEl.style.display = 'block';
  }

  joinBtn.addEventListener('click', doJoin);
  nickInput.addEventListener('keydown', e => { if (e.key === 'Enter') doJoin(); });
  if (roomInput) roomInput.addEventListener('keydown', e => { if (e.key === 'Enter') nickInput.focus(); });
}

function htmlWaiting() {
  return `
<div style="height:100dvh;background:${C.orange};color:#fff;font-family:Lato,sans-serif;position:relative;overflow:hidden">
  <!-- Decorative shapes -->
  <div style="position:absolute;inset:0;pointer-events:none;overflow:hidden">
    <div style="position:absolute;top:64px;right:-24px;opacity:0.14">${shapeSVG('triangle',160,'#fff')}</div>
    <div style="position:absolute;top:300px;left:-16px;opacity:0.11">${shapeSVG('circle',140,'#fff')}</div>
    <div style="position:absolute;bottom:180px;right:36px;opacity:0.12;transform:rotate(12deg)">${shapeSVG('square',100,'#fff')}</div>
    <div style="position:absolute;bottom:90px;left:24px;opacity:0.16">${shapeSVG('diamond',80,'#fff')}</div>
  </div>

  <div style="height:100%;display:flex;flex-direction:column;padding:40px 28px 32px;box-sizing:border-box;position:relative">
    ${MARK_COMPACT}

    <div style="flex:1;display:flex;flex-direction:column;justify-content:center">
      <div style="font-size:11px;font-weight:800;letter-spacing:2px;text-transform:uppercase;opacity:0.8">You're in</div>
      <div style="font-size:54px;font-weight:900;line-height:1.0;letter-spacing:-1.5px;margin-top:6px">
        Hi,<br>${escHtml(S.nickname)}!
      </div>
      <div style="width:48px;height:4px;background:#fff;margin:20px 0"></div>
      <div style="font-size:18px;font-weight:500;line-height:1.4;max-width:280px;opacity:0.95">
        Hang tight — the game starts when your tutor is ready.
      </div>
    </div>

    <div style="background:rgba(0,0,0,0.16);padding:14px 18px;display:flex;align-items:center;gap:12px">
      <div style="display:flex;gap:4px">
        <div style="width:8px;height:8px;border-radius:50%;background:#fff;opacity:0.55"></div>
        <div style="width:8px;height:8px;border-radius:50%;background:#fff;opacity:0.75"></div>
        <div style="width:8px;height:8px;border-radius:50%;background:#fff;opacity:0.95"></div>
      </div>
      <div style="font-size:14px;font-weight:700">Waiting for tutor…</div>
      <div style="flex:1"></div>
      <div style="font-size:13px;font-weight:700;opacity:0.7">${S.totalPlayers || ''} in</div>
    </div>
  </div>
</div>`;
}

function htmlPreQuestion() {
  const q = S.currentQ;
  return `
<style>@keyframes pqPulse{0%,100%{opacity:0.45}50%{opacity:1}}</style>
<div style="height:100dvh;background:${C.dark};color:#fff;font-family:Lato,sans-serif;display:flex;flex-direction:column;overflow:hidden">

  <!-- Progress bar -->
  <div style="padding:14px 20px 0;display:flex;align-items:center;gap:12px">
    <div style="font-size:11px;font-weight:800;letter-spacing:1.5px;color:rgba(255,255,255,0.5);text-transform:uppercase;white-space:nowrap">Q ${S.qIndex} / ${S.qTotal}</div>
    <div style="flex:1;height:4px;background:rgba(255,255,255,0.1)">
      <div style="height:100%;width:${Math.round((S.qIndex / S.qTotal) * 100)}%;background:${C.orange}"></div>
    </div>
  </div>

  <!-- Question text -->
  <div style="flex:1;padding:20px 22px 10px;display:flex;flex-direction:column;justify-content:flex-start;overflow:auto">
    <div style="font-size:11px;font-weight:800;letter-spacing:1.5px;color:${C.orange};text-transform:uppercase;margin-bottom:10px">Read the question</div>
    <div style="font-size:21px;font-weight:800;line-height:1.3;text-wrap:balance">${escHtml(q.q)}</div>
  </div>

  <!-- Disabled tiles (shape only, dimmed) -->
  <div style="padding:8px 16px 16px;display:grid;grid-template-columns:1fr 1fr;gap:10px">
    ${TILES.map(t => `
      <div style="background:${t.color};opacity:0.35;height:90px;display:flex;align-items:center;justify-content:center">
        ${shapeSVG(t.shape, 44, '#fff')}
      </div>`).join('')}
  </div>

  <!-- Pulsing "get ready" indicator -->
  <div style="padding:0 22px 20px;text-align:center">
    <div style="display:inline-flex;align-items:center;gap:8px;font-size:13px;font-weight:800;letter-spacing:1px;
                color:${C.orange};animation:pqPulse 1.4s ease-in-out infinite">
      <span>⏳</span> Get ready…
    </div>
  </div>
</div>`;
}

function htmlQuestion() {
  const q = S.currentQ;
  const dur = q?.time || 30;
  return `
<div style="height:100dvh;background:${C.dark};color:#fff;font-family:Lato,sans-serif;display:flex;flex-direction:column;overflow:hidden">

  <!-- Timer bar -->
  <div style="padding:14px 20px 0;display:flex;align-items:center;gap:12px">
    <div style="font-size:11px;font-weight:800;letter-spacing:1.5px;color:rgba(255,255,255,0.5);text-transform:uppercase;white-space:nowrap">Q ${S.qIndex} / ${S.qTotal}</div>
    <div style="flex:1;height:4px;background:rgba(255,255,255,0.1)">
      <div id="timer-bar" style="height:100%;width:100%;background:${C.orange};transition:width 0.25s linear"></div>
    </div>
    <div id="timer-txt" style="font-size:15px;font-weight:900;color:${C.orange};font-variant-numeric:tabular-nums;white-space:nowrap;min-width:36px;text-align:right">${dur}s</div>
  </div>

  <!-- Question text -->
  <div style="padding:16px 22px 10px">
    <div style="font-size:19px;font-weight:800;line-height:1.3;text-wrap:balance">${escHtml(q.q)}</div>
  </div>

  <!-- Answer tiles — fill remaining height -->
  <div style="flex:1;padding:6px 16px 16px;display:grid;grid-template-columns:1fr 1fr;grid-template-rows:1fr 1fr;gap:10px;min-height:0">
    ${TILES.map((t, i) => `
      <button data-answer="${i}"
        style="background:${t.color};border:none;border-radius:0;cursor:pointer;
               display:flex;flex-direction:column;align-items:center;justify-content:center;
               gap:10px;padding:12px;-webkit-tap-highlight-color:transparent;
               touch-action:manipulation;position:relative;overflow:hidden">
        ${shapeSVG(t.shape, 52, '#fff')}
        <div style="background:rgba(0,0,0,0.22);padding:8px 10px;font-family:Lato,sans-serif;font-size:22px;font-weight:900;color:#fff;line-height:1">${t.letter}</div>
      </button>`).join('')}
  </div>

  <div style="padding:0 22px 10px;font-size:11px;font-weight:700;letter-spacing:1.5px;color:rgba(255,255,255,0.35);text-transform:uppercase;text-align:center">
    Tap your answer
  </div>
</div>`;
}

function bindQuestion() {
  document.querySelectorAll('[data-answer]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (S.phase !== 'question') return;
      const idx = parseInt(btn.dataset.answer, 10);
      playAnswerLock();
      send({ type: 'answer', answerIndex: idx });
      // Optimistic locked state
      S.chosenAnswer = idx;
      S.answeredCount = 0;
      setPhase('locked');
    });
  });
}

function htmlLocked() {
  const tile = S.chosenAnswer !== null ? TILES[S.chosenAnswer] : null;
  const bg   = tile ? tile.color : C.dark;
  const pct  = S.totalPlayers ? Math.round((S.answeredCount / S.totalPlayers) * 100) : 0;

  return `
<div style="height:100dvh;background:${bg};color:#fff;font-family:Lato,sans-serif;display:flex;flex-direction:column;overflow:hidden">
  <div style="flex:1;padding:40px 28px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:24px;text-align:center">

    ${tile ? `
    <div style="background:rgba(0,0,0,0.20);padding:28px">
      ${shapeSVG(tile.shape, 92, '#fff')}
    </div>` : ''}

    <div>
      <div style="font-size:13px;font-weight:800;letter-spacing:2px;text-transform:uppercase;opacity:0.85">Answer locked</div>
      ${tile ? `<div style="font-size:50px;font-weight:900;line-height:1.0;margin-top:6px;letter-spacing:-1.5px">You chose<br>${tile.letter}</div>` : `<div style="font-size:28px;font-weight:800;margin-top:8px;opacity:0.7">Time's up!</div>`}
    </div>

    <div style="font-size:16px;font-weight:500;max-width:260px;opacity:0.9;line-height:1.4">
      No takebacks. Hang on while your classmates finish.
    </div>

    <div style="width:100%;max-width:280px">
      <div style="display:flex;justify-content:space-between;font-size:12px;font-weight:700;margin-bottom:6px;opacity:0.85">
        <span>Others answering</span>
        <span id="answer-count-txt">${S.answeredCount} / ${S.totalPlayers}</span>
      </div>
      <div style="height:8px;background:rgba(0,0,0,0.2)">
        <div id="answer-progress" style="height:100%;width:${pct}%;background:#fff;transition:width 0.3s ease"></div>
      </div>
    </div>
  </div>
</div>`;
}

function bindReveal() {
  const wasCorrect = S.chosenAnswer === S.correct;
  if (wasCorrect) playCorrect(); else playWrong();
}

function htmlReveal() {
  const correct    = S.correct;
  const wasCorrect = S.chosenAnswer === correct;
  const bg         = wasCorrect ? C.lime : C.dark;
  const fg         = wasCorrect ? C.ink  : '#fff';
  const earned     = wasCorrect ? `+${S.roundScore.toLocaleString()}` : '+0';
  const correctTile = TILES[correct];

  // Rank ordinal
  const rank = S.rankPos;
  const ord  = rank === 1 ? 'st' : rank === 2 ? 'nd' : rank === 3 ? 'rd' : 'th';
  const rankChange = S.rankChange;

  return `
<div style="height:100dvh;background:${bg};color:${fg};font-family:Lato,sans-serif;display:flex;flex-direction:column;overflow:hidden">
  <div style="flex:1;padding:36px 24px 24px;display:flex;flex-direction:column;gap:18px;overflow:auto">

    <!-- Header -->
    <div style="display:flex;align-items:center;justify-content:space-between">
      <div style="font-size:11px;font-weight:800;letter-spacing:2px;text-transform:uppercase;opacity:0.65">Q ${S.qIndex} of ${S.qTotal}</div>
      <div style="font-size:11px;font-weight:800;letter-spacing:2px;text-transform:uppercase;opacity:0.65">${escHtml(S.nickname)}</div>
    </div>

    <!-- Result -->
    <div>
      <div style="font-size:13px;font-weight:800;letter-spacing:2px;text-transform:uppercase;opacity:0.6">${wasCorrect ? 'Correct!' : 'Not this time'}</div>
      <div style="font-size:80px;font-weight:900;line-height:1;letter-spacing:-3px;margin-top:4px">${wasCorrect ? '✓' : '✕'}</div>
    </div>

    <!-- Points -->
    <div style="background:${wasCorrect ? C.dark : 'rgba(255,255,255,0.1)'};color:#fff;padding:18px 20px;display:flex;align-items:center;gap:14px">
      <div>
        <div style="font-size:11px;font-weight:800;letter-spacing:1.5px;text-transform:uppercase;opacity:0.6">${wasCorrect ? 'You earned' : 'Round score'}</div>
        <div style="font-size:38px;font-weight:900;font-variant-numeric:tabular-nums;letter-spacing:-1px;line-height:1;margin-top:2px">${earned}</div>
      </div>
      <div style="width:1px;height:44px;background:rgba(255,255,255,0.2)"></div>
      <div style="flex:1;font-size:13px;font-weight:600;opacity:0.85;line-height:1.35">
        ${wasCorrect
          ? `Speed bonus · answered in ${((Date.now() - S.questionStart) / 1000).toFixed(1)}s`
          : `Correct answer: <strong>${escHtml(S.currentQ?.answers?.[correct] ?? correctTile.letter)}</strong>`}
      </div>
    </div>

    <!-- Answer grid — all 4 options; correct one highlighted, others dimmed -->
    ${S.currentQ?.answers ? `
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
      ${TILES.map((t, i) => {
        const isCorrect = i === correct;
        const isChosen  = i === S.chosenAnswer;
        return `
        <div style="background:${t.color};opacity:${isCorrect ? 1 : 0.22};padding:10px 12px;
                    outline:${isCorrect ? `3px solid ${C.lime}` : 'none'};outline-offset:-2px;
                    display:flex;align-items:center;gap:8px;position:relative;box-sizing:border-box">
          ${shapeSVG(t.shape, 18, '#fff')}
          <div style="font-size:12px;font-weight:800;color:#fff;line-height:1.2;flex:1">${escHtml(S.currentQ.answers[i] || '')}</div>
          ${isChosen && !isCorrect ? `<div style="font-size:9px;font-weight:800;color:#fff;opacity:0.9;letter-spacing:0.5px">←you</div>` : ''}
          ${isCorrect ? `<div style="font-size:9px;font-weight:800;color:${C.lime};letter-spacing:0.5px">✓</div>` : ''}
        </div>`;
      }).join('')}
    </div>` : ''}

    <!-- Rank -->
    ${rank > 0 ? `
    <div style="background:rgba(0,0,0,0.12);padding:16px 18px;display:flex;align-items:center;gap:14px">
      <div id="rank-num" style="font-size:46px;font-weight:900;font-variant-numeric:tabular-nums;line-height:1;color:${fg}">${rank}<sup style="font-size:20px;font-weight:800">${ord}</sup></div>
      <div style="flex:1">
        <div style="font-size:11px;font-weight:800;letter-spacing:1.5px;text-transform:uppercase;opacity:0.6">Your rank</div>
        <div style="font-size:14px;font-weight:700;margin-top:2px;opacity:0.85">of ${S.totalPlayers || S.leaderboard.length} players</div>
      </div>
      ${rankChange > 0 ? `<div style="font-size:12px;font-weight:800;padding:4px 10px;background:rgba(0,0,0,0.18);color:${fg}">▲ up ${rankChange}</div>` :
        rankChange < 0 ? `<div style="font-size:12px;font-weight:800;padding:4px 10px;background:rgba(0,0,0,0.18);color:${fg}">▼ down ${Math.abs(rankChange)}</div>` : ''}
    </div>` : ''}

    <div style="flex:1;min-height:16px"></div>

    <div style="font-size:13px;font-weight:700;text-align:center;opacity:0.65">
      Next question in a moment…
    </div>
  </div>
</div>`;
}

function htmlFinal() {
  const rank   = S.rankPos;
  const total  = S.leaderboard.length;
  const ord    = rank === 1 ? 'st' : rank === 2 ? 'nd' : rank === 3 ? 'rd' : 'th';
  // Use server's authoritative score from the leaderboard
  const myEntry = S.leaderboard.find(p => p.name === S.nickname);
  const score  = (myEntry?.score ?? S.score ?? 0).toLocaleString();

  return `
<div style="height:100dvh;background:${C.chalk};color:${C.ink};font-family:Lato,sans-serif;display:flex;flex-direction:column;overflow:hidden;position:relative">

  <!-- Decorative shapes -->
  <div style="position:absolute;top:56px;right:-24px;opacity:0.10;pointer-events:none">${shapeSVG('triangle',120,C.orange)}</div>
  <div style="position:absolute;top:210px;left:-16px;opacity:0.09;pointer-events:none">${shapeSVG('circle',100,C.gold)}</div>

  <div style="flex:1;padding:32px 28px;display:flex;flex-direction:column;position:relative;overflow:auto">
    ${MARK_COMPACT}

    <div style="margin-top:24px">
      ${ACCENT_LINE}
      <div style="font-size:11px;font-weight:800;letter-spacing:2px;text-transform:uppercase;color:${C.grey};margin-bottom:6px">Game over · ${escHtml(S.nickname)}</div>
      <div style="font-size:56px;font-weight:900;line-height:0.95;letter-spacing:-2px">You finished</div>
      <div style="display:flex;align-items:baseline;gap:6px;margin-top:8px">
        <div style="background:${C.orange};color:#fff;font-size:96px;font-weight:900;line-height:0.85;padding:0 16px;letter-spacing:-4px">${rank}</div>
        <div style="font-size:36px;font-weight:900;color:${C.orange}">${ord}</div>
      </div>
      <div style="font-size:16px;font-weight:600;color:${C.inkSoft};margin-top:6px">of ${total} players</div>
    </div>

    <div style="margin-top:28px;padding:22px;background:${C.dark};color:#fff">
      <div style="display:flex;align-items:baseline;justify-content:space-between">
        <div style="font-size:11px;font-weight:800;letter-spacing:1.5px;text-transform:uppercase;opacity:0.55">Total score</div>
        <div style="font-size:30px;font-weight:900;font-variant-numeric:tabular-nums;letter-spacing:-0.5px">${score}</div>
      </div>
    </div>

    <div style="flex:1;min-height:24px"></div>

    <div style="display:flex;flex-direction:column;gap:10px">
      <button id="lb-btn"
        style="width:100%;padding:18px;background:${C.orange};color:#fff;font-family:Lato,sans-serif;font-size:17px;font-weight:800;text-transform:uppercase;letter-spacing:0.3px;border:none;border-radius:0;cursor:pointer">
        See full leaderboard
      </button>
      <div style="text-align:center;font-size:13px;color:${C.grey};font-weight:600">
        Thanks for playing! · WMG Quiz
      </div>
    </div>
  </div>
</div>`;
}

function bindFinal() {
  document.getElementById('lb-btn')?.addEventListener('click', () => {
    showLeaderboardModal();
  });
}

// ── Leaderboard modal ──────────────────────────────────────────────────────
function showLeaderboardModal() {
  const overlay = document.createElement('div');
  overlay.style.cssText = `position:fixed;inset:0;background:rgba(0,0,0,0.88);z-index:100;display:flex;flex-direction:column;font-family:Lato,sans-serif;color:#fff;overflow:auto`;

  const top5 = S.leaderboard.slice(0, 10);
  const myIdx = S.leaderboard.findIndex(p => p.name === S.nickname);
  const include = top5.some(p => p.name === S.nickname) ? top5 : [...top5, S.leaderboard[myIdx]].filter(Boolean);

  overlay.innerHTML = `
<div style="flex:1;padding:32px 24px;overflow:auto">
  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:28px">
    <div style="font-size:32px;font-weight:900;letter-spacing:-1px">Final Leaderboard</div>
    <button id="close-lb" style="background:rgba(255,255,255,0.1);border:none;color:#fff;font-size:22px;width:40px;height:40px;cursor:pointer;border-radius:0">✕</button>
  </div>
  ${include.map(p => {
    const isMe = p.name === S.nickname;
    const ord = p.rank === 1 ? 'st' : p.rank === 2 ? 'nd' : p.rank === 3 ? 'rd' : 'th';
    return `
    <div style="display:flex;align-items:center;gap:16px;padding:14px 18px;margin-bottom:8px;
                background:${isMe ? C.orange : p.rank === 1 ? 'rgba(255,255,255,0.1)' : 'rgba(255,255,255,0.05)'};
                border-left:${isMe ? '4px solid #fff' : p.rank <= 3 ? `4px solid ${TILES[(p.rank-1)%4].color}` : '4px solid transparent'}">
      <div style="font-size:24px;font-weight:900;font-variant-numeric:tabular-nums;color:${p.rank <= 3 ? '#fff' : 'rgba(255,255,255,0.4)'};min-width:40px">${p.rank}<sup style="font-size:12px">${ord}</sup></div>
      <div style="flex:1;font-size:18px;font-weight:800">${escHtml(p.name)}${isMe ? ' ← you' : ''}</div>
      <div style="font-size:20px;font-weight:900;font-variant-numeric:tabular-nums">${p.score.toLocaleString()}</div>
    </div>`;
  }).join('')}
</div>`;

  document.body.appendChild(overlay);
  overlay.querySelector('#close-lb').addEventListener('click', () => overlay.remove());
}

// ── Session storage ────────────────────────────────────────────────────────
const SESSION_KEY = 'wmg-quiz-session';

function saveSession(room, nickname, token) {
  try {
    const sessions = JSON.parse(localStorage.getItem(SESSION_KEY) || '{}');
    sessions[room] = { nickname, token, savedAt: Date.now() };
    localStorage.setItem(SESSION_KEY, JSON.stringify(sessions));
  } catch {}
}

function getSession(room) {
  try {
    const sessions = JSON.parse(localStorage.getItem(SESSION_KEY) || '{}');
    const s = sessions[room];
    // Expire sessions older than 4 hours
    if (s && Date.now() - s.savedAt < 4 * 60 * 60 * 1000) return s;
  } catch {}
  return null;
}

function clearSession(room) {
  try {
    const sessions = JSON.parse(localStorage.getItem(SESSION_KEY) || '{}');
    delete sessions[room];
    localStorage.setItem(SESSION_KEY, JSON.stringify(sessions));
  } catch {}
}

// ── Utilities ──────────────────────────────────────────────────────────────
function escHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function findRank(lb, name) {
  const entry = lb.find(p => p.name === name);
  return entry ? entry.rank : 0;
}

// ── Init ───────────────────────────────────────────────────────────────────
function init() {
  const params = new URLSearchParams(window.location.search);
  const roomFromURL = params.get('room') || '';

  if (roomFromURL) {
    S.room = roomFromURL;
    const stored = getSession(roomFromURL);
    if (stored) {
      // Auto-rejoin
      S.nickname = stored.nickname;
      S.token    = stored.token;
      setPhase('waiting');
      connect();
      return;
    }
  }

  setPhase('join');
}

init();
