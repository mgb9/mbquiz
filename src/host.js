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
  leaderboard:   [],
  timerInterval: null,
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
        S.leaderboard = msg.leaderboard || [];
        setPhase('final');
      }
      break;
  }
}

// ── Phase transitions ──────────────────────────────────────────────────────
function setPhase(phase) {
  S.phase = phase;
  renderScreen();
}

// ── Timer ──────────────────────────────────────────────────────────────────
function startCountdown(durationSecs) {
  if (S.timerInterval) clearInterval(S.timerInterval);
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
<div style="min-height:100vh;background:${C.chalk};color:${C.ink};font-family:Lato,sans-serif;padding:56px;box-sizing:border-box;display:flex;flex-direction:column;position:relative;overflow:auto">
  <div style="position:absolute;top:0;right:0;height:6px;width:40%;background:${C.orange}"></div>

  <!-- Header -->
  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:36px">
    ${MARK_LIGHT}
    <div style="display:flex;align-items:center;gap:8px;color:${C.grey};font-size:13px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase">
      <svg width="8" height="8" viewBox="0 0 10 10"><polygon points="0,2 10,5 0,8" fill="${C.orange}"/></svg>
      Host · Set up game
    </div>
  </div>

  <!-- Title block -->
  <div style="margin-bottom:36px">
    ${ACCENT_LINE}
    <div style="font-size:52px;font-weight:900;line-height:1.0;letter-spacing:-1.5px">Start a new game.</div>
    <div style="font-size:18px;font-weight:400;color:${C.inkSoft};margin-top:10px;max-width:640px">
      Paste or upload a question bank. Students join with a QR code or room name.
    </div>
  </div>

  <!-- Two-column body -->
  <div style="display:grid;grid-template-columns:1.5fr 1fr;gap:36px;flex:1;min-height:0">

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
    S.defaultTime = parsedData.defaultTime || defaultSecs;
    S.flatScoring = flatScoring;
    S.qTotal      = parsedData.questions.length;

    connect(room);
    setPhase('lobby');

    // Generate the QR code — retry until qrcode.js CDN has loaded
    const tryQR = () => { if (window.QRCode) renderQR(); else setTimeout(tryQR, 200); };
    setTimeout(tryQR, 80);
  });
}

// ── 2. Lobby ───────────────────────────────────────────────────────────────
function htmlLobby() {
  const joinURL = `${window.location.origin}${window.location.pathname.replace('index.html', '')}play.html?room=${encodeURIComponent(S.room)}`;

  return `
<div style="height:100vh;background:${C.dark};color:#fff;font-family:Lato,sans-serif;padding:56px;box-sizing:border-box;display:flex;flex-direction:column;position:relative;overflow:hidden">
  ${SECTOR_BAR}

  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:28px">
    ${MARK_DARK}
    <div style="color:rgba(255,255,255,0.55);font-size:13px;font-weight:700;letter-spacing:2px;text-transform:uppercase">
      ${escHtml(S.quizTitle)}
    </div>
  </div>

  <div style="display:grid;grid-template-columns:1.4fr 1fr;gap:48px;flex:1;min-height:0">

    <!-- Left: join instructions + QR -->
    <div style="display:flex;flex-direction:column">
      <div style="font-size:16px;font-weight:800;letter-spacing:2px;text-transform:uppercase;color:${C.orange};margin-bottom:14px">Join the game</div>

      <div style="display:flex;gap:36px;align-items:flex-start;margin-bottom:auto">
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

    <!-- Right: players list -->
    <div style="display:flex;flex-direction:column;border-left:1px solid rgba(255,255,255,0.12);padding-left:36px;min-height:0;overflow:hidden">
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
    doStartTimer();
  }

  document.getElementById('start-timer-btn').addEventListener('click', doStartTimerOnce);

  function onKey(e) {
    if (e.key === ' ') { e.preventDefault(); doStartTimerOnce(); }
  }
  document.addEventListener('keydown', onKey);
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

  <!-- Answer tiles 2×2 -->
  <div style="display:grid;grid-template-columns:1fr 1fr;grid-template-rows:1fr 1fr;gap:14px;flex:1;min-height:0">
    ${TILES.map((t, i) => `
      <div style="background:${t.color};padding:20px 24px;display:flex;align-items:center;gap:16px;overflow:hidden">
        <div style="width:52px;height:52px;background:rgba(0,0,0,0.18);display:flex;align-items:center;justify-content:center;flex-shrink:0">
          ${shapeSVG(t.shape, 34, '#fff')}
        </div>
        <div style="font-family:Lato,sans-serif;font-weight:800;font-size:24px;line-height:1.15;color:#fff;text-wrap:balance">
          ${escHtml(q.answers[i] || '')}
        </div>
      </div>`).join('')}
  </div>

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
  document.getElementById('reveal-btn').addEventListener('click', () => {
    stopCountdown();
    send({ type: 'next' });
    // Show a brief loading state; onMessage('reveal') will call setPhase('reveal').
    app.innerHTML = `<div style="height:100vh;background:${C.dark};display:flex;align-items:center;justify-content:center;color:rgba(255,255,255,0.5);font-family:Lato,sans-serif;font-size:18px;font-weight:700;letter-spacing:1px">Calculating scores…</div>`;
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

  <!-- Bar chart -->
  <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:14px;height:150px;align-items:end;margin-bottom:14px">
    ${counts.map((c, i) => {
      const h          = Math.round((c / maxC) * 100);
      const isCorrect  = i === correct;
      return `
      <div style="display:flex;flex-direction:column;align-items:center;justify-content:flex-end;height:100%">
        <div style="font-size:30px;font-weight:900;margin-bottom:4px;color:${isCorrect ? C.lime : '#fff'};font-variant-numeric:tabular-nums">${c}</div>
        <div style="width:70%;min-height:6px;height:${h}%;background:${TILES[i].color};${isCorrect ? `outline:3px solid ${C.lime};outline-offset:3px` : ''}"></div>
      </div>`;
    }).join('')}
  </div>

  <!-- Answer tiles (4 across) -->
  <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:14px;flex:1;min-height:0">
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

  <!-- Top 5 rows -->
  <div style="display:flex;flex-direction:column;gap:10px;flex:1;min-height:0">
    ${board.map((p, i) => {
      const isTop = i === 0;
      return `
      <div style="display:flex;align-items:center;gap:22px;padding:16px 22px;
                  background:${isTop ? C.orange : 'rgba(255,255,255,0.06)'};
                  border-left:${isTop ? 'none' : `4px solid ${TILES[i % 4].color}`}">
        <div style="font-size:34px;font-weight:900;width:56px;font-variant-numeric:tabular-nums;line-height:1;color:${isTop ? '#fff' : 'rgba(255,255,255,0.4)'}">${p.rank}</div>
        <div style="width:44px;height:44px;border-radius:50%;background:${palette[i % palette.length]};
                    display:flex;align-items:center;justify-content:center;font-weight:900;font-size:18px;flex-shrink:0">
          ${escHtml(p.name.trim()[0]?.toUpperCase() || '?')}
        </div>
        <div style="flex:1;font-size:24px;font-weight:800">${escHtml(p.name)}</div>
        <div style="font-size:13px;font-weight:800;padding:4px 10px;
                    background:${isTop ? 'rgba(255,255,255,0.18)' : 'rgba(193,216,47,0.18)'};
                    color:${isTop ? '#fff' : C.lime};letter-spacing:0.5px">
          ${p.score.toLocaleString()} pts
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
}

// ── 7. Final / Podium ──────────────────────────────────────────────────────
function htmlFinal() {
  const podium = S.leaderboard.slice(0, 3);
  // Podium order: 2nd, 1st, 3rd
  const orderedPodium = [podium[1], podium[0], podium[2]].filter(Boolean);
  const podiumHeights = ['62%', '88%', '48%'];
  const podiumColors  = [C.blue, C.orange, C.lime];
  const podiumRanks   = [2, 1, 3];

  return `
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

  <!-- Podium -->
  <div style="flex:1;display:grid;grid-template-columns:1fr 1.1fr 1fr;align-items:end;gap:20px;padding:0 80px;min-height:0">
    ${orderedPodium.map((p, col) => {
      if (!p) return '<div></div>';
      const rank  = podiumRanks[col];
      const color = podiumColors[col];
      const h     = podiumHeights[col];
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
                    display:flex;align-items:flex-start;justify-content:center;padding-top:16px">
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
  const rows = [['Rank', 'Name', 'Score']];
  S.leaderboard.forEach(p => rows.push([p.rank, p.name, p.score]));
  const csv  = rows.map(r => r.join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
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
