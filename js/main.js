import {
  BLACK, WHITE, EMPTY, sqName, legalMoves, countDiscs,
  initialState, playMove, parseTranscript,
} from './reversi.js';
import { Engine, toEdaxBoard } from './engine.js';
import { Book } from './book.js';
import { Repetition, opponentCandidates, pickRandom } from './train.js';

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
  renderExplore();
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

// ---------- Time-capped analysis (Train) ----------
// Edax runs at rising levels up to `target`; when `capMs` runs out, the deepest finished level
// is used. The first level always finishes. onStep(step) is called after each level.
// Returns { res, level, capped } | { stale: true } | { error }.
const CAP_STEPS = [8, 12, 16, 20, 24, 28];
const capCache = new Map(); // "board|level|n" -> result
async function cappedAnalyze(board, target, n, capMs, onStep) {
  const levels = [...CAP_STEPS.filter((l) => l < target), target];
  let best = null, timer = 0, capHit = false;
  const cap = capMs ? new Promise((r) => { timer = setTimeout(() => { capHit = true; r('cap'); }, capMs); }) : null;
  try {
    for (const lv of levels) {
      const key = `${board}|${lv}|${n}`;
      let res = capCache.get(key);
      if (!res) {
        const p = engine.analyze(board, lv, n);
        const id = engine.lastId();
        res = best && cap ? await Promise.race([p, cap]) : await p;
        if (res === 'cap') { engine.abort(id); break; }
        if (res.stale) return { stale: true };
        if (res.error) return { error: res.error };
        capCache.set(key, res);
      }
      best = { res, level: lv };
      if (onStep) onStep({ ...best, capped: lv < target });
      if (capHit) break;
    }
  } finally {
    clearTimeout(timer);
  }
  return { ...best, capped: best.level < target };
}

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

const fmtScore = (v) => (v > 0 ? '+' + v : String(v));
const fmtPv = (pv) => (pv.match(/.{2}/g) || []).map((m) => (m === 'ps' ? 'pass' : m)).slice(0, 12).join(' ');
const moveSq = (name) => (Number(name[1]) - 1) * 8 + (name.charCodeAt(0) - 97);

// ---------- Scores drawn on the board: book first, Edax otherwise ----------
let edaxView = null; // { res, partial } for the current position

function clearBoardScores() {
  for (const c of cells) {
    c.classList.remove('scored', 'peek');
    const s = c.querySelector('.score');
    if (s) s.remove();
  }
}

// list: [{ sq, score, leaf }]
function paintScores(list, partial) {
  clearBoardScores();
  const shown = list.filter((m) => m.sq < 64);
  if (!shown.length) return;
  const best = Math.max(...shown.map((m) => m.score));
  for (const m of shown) {
    const el = document.createElement('div');
    el.className = 'score' + (m.score === best ? ' best' : best - m.score >= 6 ? ' bad' : '')
      + (m.leaf ? ' leaf' : '') + (partial ? ' partial' : '');
    el.textContent = fmtScore(m.score);
    if (m.umi) {
      // Umigame numbers of the position after this move: Black's (dark) and White's (light),
      // the side to move first.
      const ub = `<span class="ub">${fmtCount(m.umi.b)}</span>`, uw = `<span class="uw">${fmtCount(m.umi.w)}</span>`;
      el.innerHTML = `<span class="v">${fmtScore(m.score)}</span>`
        + `<span class="umi">${cur().toMove === WHITE ? uw + ub : ub + uw}</span>`;
      el.title = `Umigame: Black ${m.umi.b}, White ${m.umi.w}`;
    }
    cells[m.sq].appendChild(el);
    cells[m.sq].classList.add('scored');
  }
}

const fmtCount = (n) => (n < 10000 ? String(n) : n < 1e6 ? Math.round(n / 1000) + 'k' : (n / 1e6).toPrecision(2) + 'M');

// Umigame numbers { b, w } of a position, or of the position after `sq` is played.
// null while the numbers are still being computed in the background.
function umiOf(st) {
  if (!book || st.over) return { b: 1, w: 1 };
  let hit = book.find(st.board, st.toMove), mover = st.toMove;
  if (!hit) { mover = 3 - st.toMove; hit = book.find(st.board, mover); } // pass positions
  if (!hit) return { b: 1, w: 1 };
  const u = book.umigameOf(hit.index);
  if (!u) return null;
  const [m, t] = u;
  return mover === BLACK ? { b: m, w: t } : { b: t, w: m };
}

// Compute all Umigame numbers after the book loads (in a worker; in slices here if that
// fails), then repaint.
let umiWorker = null;
function computeUmigame(b) {
  if (umiWorker) { umiWorker.terminate(); umiWorker = null; }
  const progress = (done) => {
    $('book-meta').dataset.umi = `Umigame numbers: computing… ${Math.floor(done * 100)}%`;
    renderBookMeta();
  };
  const tick = () => { // fallback on the main thread
    if (book !== b) return; // another book was opened
    const done = b.umigameStep(30);
    if (done < 1) { progress(done); setTimeout(tick, 0); return; }
    umigameReady(b);
  };
  try {
    const w = new Worker(new URL('./umigame-worker.js', import.meta.url), { type: 'module' });
    umiWorker = w;
    w.onmessage = (e) => {
      if (book !== b) { w.terminate(); return; }
      const d = e.data;
      if (d.umi) { b.umigameSet(d.umi); w.terminate(); umiWorker = null; umigameReady(b); }
      else if (d.error) { w.terminate(); umiWorker = null; setTimeout(tick, 0); }
      else progress(d.progress);
    };
    w.onerror = () => { w.terminate(); umiWorker = null; setTimeout(tick, 0); };
    w.postMessage(b.dv.buffer.slice(0));
  } catch {
    setTimeout(tick, 0);
  }
}
function umigameReady(b) {
  if (book !== b) return;
  delete $('book-meta').dataset.umi;
  renderBookMeta();
  if (T.phase === 'wrong' && T.anchor && T.anchor.marks) { // add the numbers to the mistake view
    const st = T.anchor.states[T.anchor.cursor], old = T.anchor.marks.list;
    const fresh = bookList(st, probe(st));
    for (const e of old) if (!fresh.find((f) => f.sq === e.sq)) fresh.push(e); // the wrong move's Edax score
    T.anchor.marks.list = fresh;
  }
  if (mode === 'analyse' || exploring()) requestAnalysis();
}
function renderBookMeta() {
  const el = $('book-meta');
  el.textContent = `${bookName} · ${book.n.toLocaleString()} positions · level ${book.level} · ${book.date}`
    + (el.dataset.umi ? ` · ${el.dataset.umi}` : '');
}
function umiAfter(st, sq) {
  const child = playMove(st, sq);
  return child ? umiOf(child) : null;
}

// Umigame numbers after book move m; the stored best non-book move always ends its line (1 and 1).
function umiMove(st, m) {
  if (!m.inBook) return book && book.umigameReady() ? { b: 1, w: 1 } : null; // shown once computed
  return umiAfter(st, m.sq);
}

// Book moves of `info` (position `st`) for painting, with their Umigame numbers.
function bookList(st, info) {
  return info.moves.filter((m) => m.sq < 64)
    .map((m) => ({ sq: m.sq, score: m.score, leaf: !m.inBook, umi: umiMove(st, m) }));
}

function paintBoard() {
  if (mode === 'train') {
    if (!exploring()) return;
    for (const c of cells) c.classList.remove('wrong', 'right');
    if (T.phase === 'wrong' && atAnchor()) { paintAnchorMarks(); return; }
  }
  if (bookOn && bookInfo) paintScores(bookList(cur(), bookInfo), false);
  else if (edaxView) paintScores(edaxView.res.moves.map((m) => ({ sq: moveSq(m.move), score: m.score })), edaxView.partial);
  else clearBoardScores();
}

function showAnalysis(res, partial, ms) {
  $('engine-lines').innerHTML = '';
  const moves = (res.moves || []).slice().sort((a, b) => b.score - a.score);
  edaxView = moves.length ? { res: { ...res, moves }, partial } : null;
  paintBoard();
  if (!moves.length) return;
  const best = moves[0].score;

  const lines = $('engine-lines');
  for (const m of moves) {
    const sq = moveSq(m.move);
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

// ---------- Opening book ----------
let book = null;
let bookName = '';
let bookOn = store.get('bookOn', true);
let bookInfo = null;

function setBookStatus(text, isErr = false) {
  const el = $('book-status');
  el.textContent = text;
  el.classList.toggle('err', isErr);
}

function updateBook() {
  const st = cur();
  const lines = $('book-lines');
  lines.innerHTML = '';
  bookInfo = book && bookOn && !st.over ? book.probe(st.board, st.toMove) : null;
  if (!book) { setBookStatus('No book loaded. Your book is read in this browser only and never uploaded.'); return; }
  if (!bookOn) { setBookStatus('Book scores hidden'); return; }
  if (st.over) { setBookStatus('Game over'); return; }
  if (!bookInfo) { setBookStatus('Out of book' + (analysisOn ? ' (Edax scores shown)' : '')); return; }

  const i = bookInfo;
  const u = umiOf(st);
  setBookStatus(`In book · value ${fmtScore(i.value)} · ${i.nLink} book move${i.nLink === 1 ? '' : 's'}`
    + (u ? ` · Umigame Black ${u.b}, White ${u.w}` : ''));
  const best = i.moves.length ? i.moves[0].score : 0;
  for (const m of i.moves) {
    const row = document.createElement('div');
    row.className = 'eline' + (m.score === best ? ' best' : '');
    const name = m.sq === 64 ? 'pass' : sqName(m.sq);
    const mu = m.sq < 64 ? umiMove(st, m) : null;
    row.innerHTML = `<span class="m">${name}</span><span class="s">${fmtScore(m.score)}</span>`
      + `<span class="pv">${m.inBook ? 'book' : 'best non-book move'}${mu ? ` · Umigame ${mu.b} / ${mu.w}` : ''}</span>`;
    if (m.sq < 64) {
      row.onmouseenter = () => cells[m.sq].classList.add('peek');
      row.onmouseleave = () => cells[m.sq].classList.remove('peek');
      row.onclick = () => onCell(m.sq);
    }
    lines.appendChild(row);
  }
}

$('opt-book').checked = bookOn;
$('opt-book').onchange = (e) => { bookOn = e.target.checked; store.set('bookOn', bookOn); updateBook(); paintBoard(); };
$('btn-book').onclick = () => $('book-file').click();
$('book-file').onchange = async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  setBookStatus(`Reading ${file.name}…`);
  try {
    const t = performance.now();
    book = await Book.fromFile(file);
    bookName = file.name;
    $('book-meta').dataset.umi = 'Umigame numbers: computing…';
    renderBookMeta();
    computeUmigame(book);
    $('btn-book').textContent = 'Change…';
    console.log(`Book loaded in ${Math.round(performance.now() - t)} ms`);
  } catch (err) {
    book = null;
    setBookStatus('Could not read book: ' + err.message, true);
    return;
  } finally {
    e.target.value = '';
  }
  updateBook();
  paintBoard();
  if (mode === 'train' && T.phase === 'idle') { setFeedback('Book loaded. Press <b>Start</b>.'); renderTrainStats(); }
};

async function requestAnalysis() {
  const token = ++anaToken;
  if (mode === 'train' && !exploring()) { edaxView = null; return; } // training draws its own feedback
  edaxView = null;
  $('engine-lines').innerHTML = '';
  updateBook();
  paintBoard();
  // Playing on in Train: book scores if in book, otherwise Edax (always on there).
  if (mode === 'train' && (bookInfo || (T.phase === 'wrong' && atAnchor()))) return;
  if (!analysisOn && mode !== 'train') { if (engine) engine.cancel(); setEngineStatus('Off'); return; }
  ensureEngine();

  const st = cur();
  if (st.over) { engine.cancel(); setEngineStatus('Game over'); return; }
  const board = toEdaxBoard(st.board, st.toMove);
  if (mode === 'train') { // playing on: rising levels within the time cap
    const r = await cappedAnalyze(board, level, 60, T.cap * 1000, (step) => {
      if (token === anaToken) showAnalysis(step.res, step.level < level);
    });
    if (token !== anaToken || r.stale) return;
    if (r.error) { setEngineStatus('Engine error: ' + r.error, true); return; }
    showAnalysis(r.res, false);
    return;
  }
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

// ---------- Training ----------
let mode = 'analyse';
const srs = new Repetition();
const T = {
  phase: 'idle',          // idle | user | checking | trainer | wrong | end
  colorPref: store.get('trainColor', 1), // 1 black, 2 white, 3 both
  margin: store.get('trainMargin', 2),
  cap: store.get('trainCap', 3),          // seconds for Edax checks and play-on scores; 0 = none
  lineColor: BLACK,
  retrying: false,
  review: null,           // review item being replayed, if any
  line: { correct: 0, total: 0 },
  session: { correct: 0, total: 0 },
  timer: 0,
  anchor: null,           // trained position saved at a mistake or line end: { states, cursor, marks }
};
const colorName = (p) => (p === BLACK ? 'Black' : 'White');
const prefColors = () => (T.colorPref === 3 ? [BLACK, WHITE] : [T.colorPref]);

function setFeedback(html, kind = '') {
  const el = $('train-feedback');
  el.innerHTML = html;
  el.className = 'feedback' + (kind ? ' ' + kind : '');
}

function showButtons(...ids) {
  for (const id of ['btn-train-start', 'btn-train-retry', 'btn-train-accept', 'btn-train-best', 'btn-train-next', 'btn-train-copy']) $(id).hidden = !ids.includes(id);
}

function renderTrainStats() {
  const c = srs.count(prefColors());
  const s = T.session;
  $('train-stats').textContent = `Session: ${s.correct}/${s.total} correct`
    + ` · Reviews due: ${c.due} · Saved positions: ${c.total}`;
  renderMoveChart();
}

// ---------- Answers by move number (chart under the board) ----------
const MC_MOVES = 40;
// c: correct (including correct with an Umigame warning), w: correct with warning, t: answers.
const emptyStats = () => ({ c: new Array(61).fill(0), w: new Array(61).fill(0), t: new Array(61).fill(0) });
const moveStats = { session: emptyStats(), all: store.get('moveStats', null) || emptyStats() };
if (!moveStats.all.w) moveStats.all.w = new Array(61).fill(0); // saved before warnings were counted
let mcView = store.get('mcView', 'session');

// ply: move number of the user's answer (1..60).
function recordMoveStat(ply, correct, warned = false) {
  for (const s of [moveStats.session, moveStats.all]) {
    s.t[ply]++;
    if (correct) s.c[ply]++;
    if (correct && warned) s.w[ply]++;
  }
  store.set('moveStats', moveStats.all);
}
function acceptMoveStat(ply) { // a wrong answer counted as correct after all
  for (const s of [moveStats.session, moveStats.all]) if (s.c[ply] < s.t[ply]) s.c[ply]++;
  store.set('moveStats', moveStats.all);
}

function renderMoveChart() {
  const s = moveStats[mcView];
  $('mc-session').classList.toggle('active', mcView === 'session');
  $('mc-all').classList.toggle('active', mcView === 'all');
  let max = 1;
  for (let p = 1; p <= MC_MOVES; p++) max = Math.max(max, s.t[p]);
  const bars = $('mc-bars');
  bars.innerHTML = '';
  const seg = (cls, n) => {
    const el = document.createElement('span');
    el.className = cls;
    el.style.height = `${(100 * n) / max}%`;
    return el;
  };
  for (let p = 1; p <= MC_MOVES; p++) {
    const t = s.t[p], c = s.c[p], w = s.w[p];
    const bar = document.createElement('div');
    bar.className = 'mc-bar' + (t ? '' : ' empty');
    bar.title = t
      ? `Move ${p}: ${c}/${t} correct (${Math.round((100 * c) / t)}%)` + (w ? `, ${w} with Umigame warning` : '')
      : `Move ${p}: no answers`;
    if (t) bar.append(seg('ok', c - w), seg('wa', w), seg('no', t - c)); // bottom to top
    // Tooltips need a mouse; show the numbers below the chart on tap or hover too.
    bar.onclick = bar.onmouseenter = () => { $('mc-info').textContent = bar.title; };
    bars.appendChild(bar);
  }
  const axis = $('mc-axis');
  if (!axis.childElementCount) {
    for (let p = 1; p <= MC_MOVES; p++) {
      const l = document.createElement('span');
      l.textContent = p === 1 || p % 5 === 0 ? String(p) : '';
      axis.appendChild(l);
    }
  }
}
$('mc-session').onclick = () => { mcView = 'session'; store.set('mcView', mcView); renderMoveChart(); };
$('mc-all').onclick = () => { mcView = 'all'; store.set('mcView', mcView); renderMoveChart(); };

function clearMarks() {
  for (const c of cells) c.classList.remove('wrong', 'right');
  clearBoardScores();
}

function setMode(m) {
  mode = m;
  document.body.classList.toggle('training', m === 'train');
  $('tab-analyse').classList.toggle('active', m === 'analyse');
  $('tab-train').classList.toggle('active', m === 'train');
  clearTimeout(T.timer);
  T.phase = 'idle';
  T.anchor = null;
  T.last = null;
  clearMarks();
  if (m === 'train') {
    if (engine) engine.cancel();
    setFeedback(book ? 'Choose your colour, then press <b>Start</b>.' : 'Open your book (below), then press <b>Start</b>.');
    showButtons('btn-train-start');
    renderTrainStats();
  }
  render();
}

// Play a move during training (keeps the move list consistent).
function pushMove(sq) {
  const st = playMove(cur(), sq);
  if (!st) return false;
  states = states.slice(0, cursor + 1);
  states.push(st);
  cursor++;
  render(true);
  return true;
}

const probe = (st) => (book ? book.probe(st.board, st.toMove) : null);
const bestScore = (info) => Math.max(...info.moves.filter((m) => m.sq < 64).map((m) => m.score));
const lineSoFar = () => states.slice(1, cursor + 1).map((s) => sqName(s.move)).join('');

// After a mistake or at the end of a line the user may play on and step through the moves
// ("exploring"). The trained position is kept in T.anchor so Retry / Play best can return to it.
function exploring() { return mode === 'train' && (T.phase === 'wrong' || T.phase === 'end'); }
function atAnchor() { return !!T.anchor && cur() === T.anchor.states[T.anchor.cursor]; }
function setAnchor(marks = null) { T.anchor = { states: states.slice(), cursor, marks }; }
function restoreAnchor() {
  if (!T.anchor) return;
  states = T.anchor.states.slice();
  cursor = T.anchor.cursor;
  render();
}
function paintAnchorMarks() {
  const m = T.anchor.marks;
  if (!m) return;
  paintScores(m.list, false);
  cells[m.wrong].classList.add('wrong');
  for (const s of m.right) cells[s].classList.add('right');
}
function renderExplore() {
  const on = exploring() && !!T.anchor;
  document.body.classList.toggle('exploring', on);
  const el = $('train-explore');
  if (!on) { el.textContent = ''; return; }
  el.textContent = atAnchor()
    ? (matchMedia('(pointer: coarse)').matches
      ? 'Tap any move to play on from here. Use ◀ ▶ to step through the moves.'
      : 'Click any move to play on from here. Use ◀ ▶ or the arrow keys to step through the moves.')
    : 'Playing on from the trained position.'
      + (T.phase === 'wrong' ? ' Retry, Accept and Play best & continue go back to it.' : '');
}

function startLine() {
  clearTimeout(T.timer);
  T.phase = 'idle';
  T.anchor = null;
  T.last = null;
  clearMarks();
  if (!book) { setFeedback('Open your book first.', 'bad'); return; }
  T.line = { correct: 0, total: 0 };
  T.retrying = false;
  ensureEngine();

  const due = srs.due(prefColors());
  if (due.length) {
    const item = due[0];
    const { states: parsed, error } = parseTranscript(item.line);
    if (!error) {
      T.review = item;
      T.lineColor = item.color;
      states = parsed;
      cursor = states.length - 1;
      render();
      userTurn(`Review (${due.length} due): you play <b>${colorName(item.color)}</b>.`);
      return;
    }
  }
  T.review = null;
  T.lineColor = T.colorPref === 3 ? (Math.random() < 0.5 ? BLACK : WHITE) : T.colorPref;
  states = [initialState()];
  cursor = 0;
  render();
  if (cur().toMove === T.lineColor) userTurn(`New line: you play <b>${colorName(T.lineColor)}</b>.`);
  else trainerTurn();
}

// A book leaf (in the book, no book moves) is still quizzed on its stored best move; the line ends after it.
const OUT_OF_BOOK = 'Out of book.';

// Score of the last move on the line that has a book score, from the trained colour's side.
function lastBookScore() {
  for (let i = cursor; i >= 1; i--) {
    const prev = states[i - 1], info = probe(prev);
    const entry = info && info.moves.find((m) => m.sq === states[i].move);
    if (entry) return { score: prev.toMove === T.lineColor ? entry.score : -entry.score, ply: i, move: sqName(states[i].move) };
  }
  return null;
}

// Result of the user's previous move, kept on screen until the next answer.
function lastHtml() {
  return T.last ? `<span class="last${T.lastWarn ? ' warn' : ''}">${T.last}</span>` : '';
}

function endLine(reason) {
  T.phase = 'end';
  const l = T.line;
  const last = reason === OUT_OF_BOOK ? lastBookScore() : null;
  const lastBook = last
    ? `<br>Last book score: <b>${fmtScore(last.score)}</b> for you (${colorName(T.lineColor)}), after ${last.ply}.${last.move}.`
    : '';
  setFeedback(`${lastHtml()}${reason}${lastBook}<span class="sub">This line: ${l.correct}/${l.total} correct.</span>`, 'end');
  showButtons('btn-train-next', 'btn-train-copy');
  renderTrainStats();
  setAnchor();
  renderExplore();
  requestAnalysis();
}

function userTurn(intro = '') {
  const st = cur();
  if (st.over) { endLine('Game over.'); return; }
  if (st.toMove !== T.lineColor) { trainerTurn(); return; }
  const info = probe(st);
  if (!info || !info.moves.some((m) => m.sq < 64)) { endLine(OUT_OF_BOOK); return; }
  const legal = legalMoves(st.board, st.toMove);
  if (legal.length === 1) { // forced move: nothing to train
    T.phase = 'trainer';
    T.timer = setTimeout(() => { pushMove(legal[0]); T.timer = setTimeout(trainerTurn, 450); }, 350);
    return;
  }
  T.phase = 'user';
  setFeedback(lastHtml() + `${intro ? intro + '<br>' : ''}Your move as <b>${colorName(T.lineColor)}</b>: find the best move.`);
  showButtons('btn-train-next');
}

function trainerTurn() {
  const st = cur();
  if (st.over) { endLine('Game over.'); return; }
  if (st.toMove === T.lineColor) { userTurn(); return; }
  const info = probe(st);
  if (!info) { endLine(OUT_OF_BOOK); return; }
  const cands = opponentCandidates(info, T.margin);
  if (!cands.length) { endLine(OUT_OF_BOOK); return; }
  T.phase = 'trainer';
  T.timer = setTimeout(() => {
    pushMove(pickRandom(cands).sq);
    T.timer = setTimeout(() => (cur().toMove === T.lineColor ? userTurn() : trainerTurn()), 450);
  }, 350);
}

// Score of `sq` for the side to move in `st`: book first, Edax if the move is not in the book.
async function moveScore(st, info, sq) {
  const entry = info.moves.find((m) => m.sq === sq);
  if (entry) return { score: entry.score, source: entry.inBook ? 'book' : 'book (best non-book move)' };
  const child = playMove(st, sq);
  if (child.over) {
    const { black, white } = countDiscs(child.board);
    const diff = st.toMove === BLACK ? black - white : white - black;
    return { score: diff, source: 'final score' };
  }
  const r = await cappedAnalyze(toEdaxBoard(child.board, child.toMove), level, 1, T.cap * 1000, (step) => {
    if (T.phase === 'checking' && step.level < level) setFeedback(`Checking… (Edax level ${step.level} done)`);
  });
  const res = r.res;
  if (r.stale || r.error || !res || !res.moves || !res.moves.length) return null;
  const s = res.moves[0].score;
  return {
    score: child.toMove === st.toMove ? s : -s,
    source: `Edax level ${r.level}` + (r.capped ? ` (time cap ${T.cap} s; level ${level} not reached)` : ''),
  };
}

// After a correct move `sq` in position `st`: text naming the other best moves that need fewer
// lines to memorise (lower Umigame number for the mover, or equal and higher for the opponent),
// or '' if there are none or the numbers are not computed yet.
function umigameWarning(st, info, sq, best) {
  if (!book || !book.umigameReady()) return '';
  const mineOf = (u) => (st.toMove === BLACK ? u.b : u.w);
  const theirsOf = (u) => (st.toMove === BLACK ? u.w : u.b);
  const entry = info.moves.find((m) => m.sq === sq);
  const own = entry ? umiMove(st, entry) : { b: 1, w: 1 }; // a move outside the book ends its line
  if (!own) return '';
  const better = info.moves
    .filter((m) => m.sq < 64 && m.sq !== sq && m.score === best)
    .map((m) => ({ m, u: umiMove(st, m) }))
    .filter(({ u }) => u && (mineOf(u) < mineOf(own) || (mineOf(u) === mineOf(own) && theirsOf(u) > theirsOf(own))))
    .sort((a, b) => mineOf(a.u) - mineOf(b.u) || theirsOf(b.u) - theirsOf(a.u));
  if (!better.length) return '';
  const fmt = (u) => `${fmtCount(mineOf(u))} · ${fmtCount(theirsOf(u))}`;
  return `Umigame ${fmt(own)}; better Umigame: ${better.map(({ m, u }) => `<b>${sqName(m.sq)}</b> ${fmt(u)}`).join(', ')}.`;
}

async function trainClick(sq) {
  if (T.phase !== 'user') return;
  const st = cur();
  if (!playMove(st, sq)) return;
  const info = probe(st);
  T.phase = 'checking';
  setFeedback('Checking…');
  const r = await moveScore(st, info, sq);
  if (mode !== 'train' || cur() !== st) return;
  if (!r) { T.phase = 'user'; setFeedback('Could not score that move. Try again.', 'bad'); return; }

  const best = bestScore(info);
  // A move outside the book is never correct where the book has moves of its own
  // (the stored best non-book move is in info.moves, so it can still be correct).
  const offBook = !info.moves.some((m) => m.sq === sq) && info.nLink > 0;
  const correct = !offBook && r.score >= best;
  const warn = correct ? umigameWarning(st, info, sq, best) : '';
  const key = book.recordKey(info.index);
  const undo = T.retrying ? null : { key, prev: srs.get(key) }; // lets Accept revert this record
  if (!T.retrying) {
    srs.record(key, lineSoFar(), T.lineColor, correct);
    T.line.total++; T.session.total++;
    if (correct) { T.line.correct++; T.session.correct++; }
    recordMoveStat(cursor + 1, correct, !!warn);
  }
  renderTrainStats();

  if (correct) {
    T.retrying = false;
    const others = info.moves.filter((m) => m.sq < 64 && m.score === best && m.sq !== sq).map((m) => sqName(m.sq));
    const verdict = warn ? 'correct with warning' : 'correct';
    T.lastWarn = !!warn;
    T.last = `<b>${cursor + 1}.${sqName(sq)} ${fmtScore(r.score)}</b>: ${verdict}.`
      + (warn ? ` ${warn}` : others.length ? ` Also best: ${others.join(', ')}` : '');
    setFeedback(`<b>${sqName(sq)} ${fmtScore(r.score)}</b>: ${verdict}.`
      + (warn ? `<span class="sub">${warn}</span>`
        : others.length ? `<span class="sub">Also best: ${others.join(', ')}</span>` : ''), warn ? 'warn' : 'good');
    pushMove(sq);
    T.phase = 'trainer';
    T.timer = setTimeout(trainerTurn, 650);
    return;
  }

  // Wrong: show all scores for this position, mark the chosen square.
  T.phase = 'wrong';
  T.last = null;
  const list = bookList(st, info);
  if (!list.find((m) => m.sq === sq)) list.push({ sq, score: r.score });
  paintScores(list, false);
  cells[sq].classList.add('wrong');
  const bestMoves = info.moves.filter((m) => m.sq < 64 && m.score === best);
  for (const m of bestMoves) cells[m.sq].classList.add('right');
  setAnchor({ list, wrong: sq, right: bestMoves.map((m) => m.sq) });
  T.anchor.undo = undo;
  renderExplore();
  const loss = best - r.score;
  setFeedback(`<b>${sqName(sq)} ${fmtScore(r.score)}</b> `
    + (offBook && loss <= 0 ? 'is not a book move.' : `loses ${loss} disc${loss === 1 ? '' : 's'}${offBook ? ' (not a book move)' : ''}.`)
    + ` Best: <b>${bestMoves.map((m) => sqName(m.sq) + ' ' + fmtScore(m.score)).join(', ')}</b>`
    + `<span class="sub">Score source: ${r.source}. This position is saved for review.</span>`, 'bad');
  showButtons('btn-train-retry', 'btn-train-accept', 'btn-train-best', 'btn-train-next', 'btn-train-copy');
}

$('tab-analyse').onclick = () => setMode('analyse');
$('tab-train').onclick = () => setMode('train');
$('opt-train-color').value = String(T.colorPref);
$('opt-train-margin').value = String(T.margin);
$('opt-train-color').onchange = (e) => { T.colorPref = Number(e.target.value); store.set('trainColor', T.colorPref); renderTrainStats(); };
$('opt-train-margin').onchange = (e) => { T.margin = Number(e.target.value); store.set('trainMargin', T.margin); };
$('opt-train-cap').value = String(T.cap);
$('opt-train-cap').onchange = (e) => { T.cap = Number(e.target.value); store.set('trainCap', T.cap); };
$('btn-train-start').onclick = startLine;
$('btn-train-next').onclick = startLine;
$('btn-train-copy').onclick = async () => {
  const text = `${lineSoFar()} ${colorName(T.lineColor).toLowerCase()}`;
  const btn = $('btn-train-copy');
  try { await navigator.clipboard.writeText(text); btn.textContent = 'Copied'; }
  catch { btn.textContent = 'Copy failed'; }
  setTimeout(() => { btn.textContent = 'Copy transcript with colour'; }, 1500);
};
$('btn-train-retry').onclick = () => {
  if (T.phase !== 'wrong') return;
  restoreAnchor();
  clearMarks();
  T.retrying = true;
  T.phase = 'user';
  renderExplore();
  setFeedback('Try again: find the best move.');
  showButtons('btn-train-next');
};
// Accept: treat the move as correct after all, undo the review entry and continue the line with it.
$('btn-train-accept').onclick = () => {
  if (T.phase !== 'wrong' || !T.anchor || !T.anchor.marks) return;
  const { wrong: sq } = T.anchor.marks;
  const undo = T.anchor.undo;
  restoreAnchor();
  clearMarks();
  if (undo) {
    // Undo the miss, then record it as a correct answer (moves a due review up a box).
    srs.put(undo.key, undo.prev);
    srs.record(undo.key, lineSoFar(), T.lineColor, true);
    T.line.correct++; T.session.correct++;
    acceptMoveStat(cursor + 1);
  }
  renderTrainStats();
  T.retrying = false;
  T.phase = 'trainer';
  setFeedback(`<b>${sqName(sq)}</b>: accepted.<span class="sub">Not saved for review.</span>`, 'good');
  T.last = `<b>${cursor + 1}.${sqName(sq)}</b>: accepted (not saved for review).`;
  showButtons('btn-train-next');
  T.lastWarn = false;
  pushMove(sq);
  T.timer = setTimeout(trainerTurn, 650);
};
$('btn-train-best').onclick = () => {
  if (T.phase !== 'wrong') return;
  restoreAnchor();
  const info = probe(cur());
  clearMarks();
  if (!info) return;
  const best = bestScore(info);
  const pick = info.moves.find((m) => m.sq < 64 && m.inBook && m.score === best) || info.moves.find((m) => m.sq < 64 && m.score === best);
  T.retrying = false;
  T.phase = 'trainer';
  T.last = `<b>${cursor + 1}.${sqName(pick.sq)} ${fmtScore(pick.score)}</b>: best move played.`;
  T.lastWarn = false;
  showButtons('btn-train-next');
  pushMove(pick.sq);
  T.timer = setTimeout(trainerTurn, 450);
};

// ---------- Actions ----------
function onCell(s) {
  if (mode === 'train' && !exploring()) { trainClick(s); return; }
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
  if (mode === 'train' && !exploring()) return;
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
