import {
  BLACK, WHITE, EMPTY, sqName, legalMoves, countDiscs,
  initialState, playMove, parseTranscript,
} from './reversi.js';
import { Engine, toEdaxBoard } from './engine.js';

// ---------- Settings (per browser) ----------
const store = {
  get(k, d) { try { const v = localStorage.getItem('ot.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('ot.' + k, JSON.stringify(v)); } catch { /* ignore */ } },
};

// ---------- Game state ----------
let states = [initialState()];
let cursor = 0;
const cur = () => states[cursor];

// ---------- DOM ----------
const $ = (id) => document.getElementById(id);
const boardEl = $('board');
const cells = [];
const discEls = new Array(64).fill(null);
const shown = new Array(64).fill(EMPTY);

for (let s = 0; s < 64; s++) {
  const c = document.createElement('div');
  c.className = 'cell';
  c.dataset.sq = s;
  c.setAttribute('role', 'gridcell');
  c.setAttribute('aria-label', sqName(s));
  c.addEventListener('click', () => onCell(s));
  boardEl.appendChild(c);
  cells.push(c);
}

// The four marker dots sit on grid intersections b2/c3, f2/g3, b6/c7, f6/g7.
for (const [x, y] of [[2, 2], [6, 2], [2, 6], [6, 6]]) {
  const d = document.createElement('div');
  d.className = 'dot';
  d.style.left = `calc(${x} * (100% - var(--g)) / 8 + var(--g) / 2)`;
  d.style.top = `calc(${y} * (100% - var(--g)) / 8 + var(--g) / 2)`;
  boardEl.appendChild(d);
}

function makeDisc(color, drop) {
  const holder = document.createElement('div');
  holder.className = 'holder' + (drop ? ' drop' : '');
  const disc = document.createElement('div');
  disc.className = 'disc' + (color === WHITE ? ' is-white' : '');
  disc.innerHTML = '<div class="face black"></div><div class="face white"></div>';
  holder.appendChild(disc);
  return holder;
}

// ---------- Rendering ----------
function renderBoard(animate) {
  const st = cur();
  const b = st.board;
  const mr = st.move >> 3, mc = st.move & 7;

  for (let s = 0; s < 64; s++) {
    const v = b[s];
    if (v === EMPTY) {
      if (discEls[s]) { discEls[s].remove(); discEls[s] = null; }
    } else if (!discEls[s]) {
      discEls[s] = makeDisc(v, animate && s === st.move);
      cells[s].appendChild(discEls[s]);
    } else if (shown[s] !== v) {
      const disc = discEls[s].firstChild;
      // Ripple the flips outward from the played square.
      const dist = animate && st.move >= 0 ? Math.max(Math.abs((s >> 3) - mr), Math.abs((s & 7) - mc)) : 0;
      disc.style.transitionDelay = animate ? `${60 + dist * 55}ms` : '0ms';
      disc.classList.toggle('is-white', v === WHITE);
    }
    shown[s] = v;
    cells[s].classList.remove('legal', 'w', 'last');
  }

  if (st.move >= 0) cells[st.move].classList.add('last');
  if (!st.over) {
    for (const m of legalMoves(b, st.toMove)) {
      cells[m].classList.add('legal');
      if (st.toMove === WHITE) cells[m].classList.add('w');
    }
  }
}

function renderStatus() {
  const st = cur();
  const { black, white } = countDiscs(st.board);
  $('count-black').textContent = black;
  $('count-white').textContent = white;
  $('side-black').classList.toggle('active', !st.over && st.toMove === BLACK);
  $('side-white').classList.toggle('active', !st.over && st.toMove === WHITE);

  const name = (p) => (p === BLACK ? 'Black' : 'White');
  let text;
  if (st.over) {
    text = black === white ? `Game over: draw ${black}–${white}`
      : `Game over: ${black > white ? 'Black' : 'White'} wins ${Math.max(black, white)}–${Math.min(black, white)}`;
  } else if (st.passed) {
    text = `${name(3 - st.toMove)} passes. ${name(st.toMove)} to move`;
  } else {
    text = `${name(st.toMove)} to move`;
  }
  $('status').textContent = text;

  $('btn-first').disabled = $('btn-back').disabled = cursor === 0;
  $('btn-fwd').disabled = $('btn-last').disabled = cursor === states.length - 1;
}

function renderMoves() {
  const el = $('moves');
  el.innerHTML = '';
  for (let i = 1; i < states.length; i++) {
    const st = states[i];
    const d = document.createElement('div');
    d.className = 'mv' + (i === cursor ? ' current' : '') + (i > cursor ? ' future' : '');
    d.innerHTML = `<span class="n">${i}</span><span class="c ${st.mover === BLACK ? 'b' : 'w'}"></span>${sqName(st.move)}`;
    d.addEventListener('click', () => goTo(i));
    el.appendChild(d);
  }
  const currentEl = el.querySelector('.current');
  if (currentEl) currentEl.scrollIntoView({ block: 'nearest' });
}

const transcript = () => states.slice(1).map((s) => sqName(s.move)).join('');

function render(animate = false) {
  renderBoard(animate);
  renderStatus();
  renderMoves();
  const ta = $('transcript');
  if (document.activeElement !== ta) ta.value = transcript();
  requestAnalysis();
}

// ---------- Edax analysis ----------
let engine = null;
let engineState = 'off';
let analysisOn = store.get('edax', false);
let level = store.get('level', 18);
let anaToken = 0;
const cache = new Map(); // "board|level" -> { moves, ms }

const QUICK_LEVEL = 8;

function setEngineStatus(text, isErr = false) {
  const el = $('engine-status');
  el.textContent = text;
  el.classList.toggle('err', isErr);
}

function ensureEngine() {
  if (engine) return;
  engine = new Engine((state, err) => {
    engineState = state;
    if (state === 'loading') setEngineStatus('Loading Edax…');
    else if (state === 'error') setEngineStatus('Engine error: ' + err, true);
    else if (state === 'ready') requestAnalysis();
  });
}

function clearScores() {
  for (const c of cells) {
    c.classList.remove('scored', 'peek');
    const s = c.querySelector('.score');
    if (s) s.remove();
  }
  $('engine-lines').innerHTML = '';
}

const fmtScore = (v) => (v > 0 ? '+' + v : String(v));
const fmtPv = (pv) => (pv.match(/.{2}/g) || []).map((m) => (m === 'ps' ? 'pass' : m)).slice(0, 12).join(' ');

function showAnalysis(res, partial, ms) {
  clearScores();
  const moves = (res.moves || []).slice().sort((a, b) => b.score - a.score);
  if (!moves.length) return;
  const best = moves[0].score;

  for (const m of moves) {
    const sq = (Number(m.move[1]) - 1) * 8 + (m.move.charCodeAt(0) - 97);
    const el = document.createElement('div');
    el.className = 'score' + (m.score === best ? ' best' : best - m.score >= 6 ? ' bad' : '') + (partial ? ' partial' : '');
    el.textContent = fmtScore(m.score);
    cells[sq].appendChild(el);
    cells[sq].classList.add('scored');
  }

  const lines = $('engine-lines');
  for (const m of moves) {
    const sq = (Number(m.move[1]) - 1) * 8 + (m.move.charCodeAt(0) - 97);
    const row = document.createElement('div');
    row.className = 'eline' + (m.score === best ? ' best' : '');
    row.innerHTML = `<span class="m">${m.move}</span><span class="s">${fmtScore(m.score)}</span><span class="pv">${fmtPv(m.pv)}</span>`;
    row.title = fmtPv(m.pv);
    row.onmouseenter = () => cells[sq].classList.add('peek');
    row.onmouseleave = () => cells[sq].classList.remove('peek');
    row.onclick = () => onCell(sq);
    lines.appendChild(row);
  }

  const d = moves[0];
  const depthText = d.selectivity < 100 ? `depth ${d.depth}@${d.selectivity}%` : `depth ${d.depth}`;
  const exact = d.depth >= res.empties && d.selectivity === 100;
  setEngineStatus(partial ? `Thinking… (quick ${depthText})`
    : `Level ${level} · ${exact ? 'exact' : depthText}${ms != null ? ` · ${(ms / 1000).toFixed(1)}s` : ''}`);
}

async function requestAnalysis() {
  const token = ++anaToken;
  clearScores();
  if (!analysisOn) { if (engine) engine.cancel(); setEngineStatus('Off'); return; }
  ensureEngine();

  const st = cur();
  if (st.over) { engine.cancel(); setEngineStatus('Game over'); return; }
  const board = toEdaxBoard(st.board, st.toMove);
  const key = board + '|' + level;
  if (cache.has(key)) { const c = cache.get(key); showAnalysis(c, false, c.ms); return; }
  if (engineState !== 'ready') { setEngineStatus('Loading Edax…'); }
  else setEngineStatus('Thinking…');

  if (level > QUICK_LEVEL) {
    const quick = await engine.analyze(board, QUICK_LEVEL, 60);
    if (token !== anaToken || quick.stale) return;
    if (quick.error) { setEngineStatus('Engine error: ' + quick.error, true); return; }
    showAnalysis(quick, true);
  }
  const t = performance.now();
  const res = await engine.analyze(board, level, 60);
  if (token !== anaToken || res.stale) return;
  if (res.error) { setEngineStatus('Engine error: ' + res.error, true); return; }
  res.ms = performance.now() - t;
  cache.set(key, res);
  showAnalysis(res, false, res.ms);
}

$('opt-edax').checked = analysisOn;
$('opt-level').value = String(level);
$('opt-edax').onchange = (e) => { analysisOn = e.target.checked; store.set('edax', analysisOn); requestAnalysis(); };
$('opt-level').onchange = (e) => { level = Number(e.target.value); store.set('level', level); requestAnalysis(); };

// ---------- Actions ----------
function onCell(s) {
  const next = states[cursor + 1];
  if (next && next.move === s) { cursor++; render(true); return; }
  const st = playMove(cur(), s);
  if (!st) return;
  states = states.slice(0, cursor + 1);
  states.push(st);
  cursor++;
  render(true);
}

function goTo(i) {
  i = Math.max(0, Math.min(states.length - 1, i));
  if (i === cursor) return;
  const step = i === cursor + 1;
  cursor = i;
  render(step);
}

function setMsg(text, isErr = false) {
  const m = $('msg');
  m.textContent = text;
  m.classList.toggle('err', isErr);
  clearTimeout(setMsg.t);
  setMsg.t = setTimeout(() => { m.textContent = ''; }, 3500);
}

$('btn-first').onclick = () => goTo(0);
$('btn-back').onclick = () => goTo(cursor - 1);
$('btn-fwd').onclick = () => goTo(cursor + 1);
$('btn-last').onclick = () => goTo(states.length - 1);
$('btn-new').onclick = () => { states = [initialState()]; cursor = 0; render(); };

$('opt-hints').onchange = (e) => boardEl.classList.toggle('hints-off', !e.target.checked);

$('btn-load').onclick = () => {
  const { states: parsed, error } = parseTranscript($('transcript').value);
  states = parsed;
  cursor = states.length - 1;
  $('transcript').blur();
  render();
  if (error) setMsg(error + '. Loaded up to there.', true);
  else setMsg(`Loaded ${states.length - 1} moves`);
};

$('btn-copy').onclick = async () => {
  try { await navigator.clipboard.writeText(transcript()); setMsg('Copied'); }
  catch { setMsg('Copy failed', true); }
};

document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT') return;
  if (e.key === 'ArrowLeft') goTo(cursor - 1);
  else if (e.key === 'ArrowRight') goTo(cursor + 1);
  else if (e.key === 'Home') goTo(0);
  else if (e.key === 'End') goTo(states.length - 1);
  else return;
  e.preventDefault();
});

render();
