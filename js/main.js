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
      // Umigame numbers of the position after this move: Black's (dark) and White's (light).
      el.innerHTML = `<span class="v">${fmtScore(m.score)}</span>`
        + `<span class="umi"><span class="ub">${fmtCount(m.umi.b)}</span><span class="uw">${fmtCount(m.umi.w)}</span></span>`;
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

// Book moves of `info` (position `st`) for painting; book moves carry their Umigame numbers.
function bookList(st, info) {
  return info.moves.filter((m) => m.sq < 64)
    .map((m) => ({ sq: m.sq, score: m.score, leaf: !m.inBook, umi: m.inBook ? umiAfter(st, m.sq) : null }));
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
    const mu = m.inBook && m.sq < 64 ? umiAfter(st, m.sq) : null;
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
}

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
    ? 'Click any move to play on from here. Use ◀ ▶ or the arrow keys to step through the moves.'
    : 'Playing on from the trained position.'
      + (T.phase === 'wrong' ? ' Retry, Accept and Play best & continue go back to it.' : '');
}

function startLine() {
  clearTimeout(T.timer);
  T.phase = 'idle';
  T.anchor = null;
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

function endLine(reason) {
  T.phase = 'end';
  const l = T.line;
  const last = reason === OUT_OF_BOOK ? lastBookScore() : null;
  const lastHtml = last
    ? `<br>Last book score: <b>${fmtScore(last.score)}</b> for you (${colorName(T.lineColor)}), after ${last.ply}.${last.move}.`
    : '';
  setFeedback(`${reason}${lastHtml}<span class="sub">This line: ${l.correct}/${l.total} correct.</span>`, 'end');
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
  setFeedback(`${intro ? intro + '<br>' : ''}Your move as <b>${colorName(T.lineColor)}</b>: find the best move.`);
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
  const res = await engine.analyze(toEdaxBoard(child.board, child.toMove), level, 1);
  if (res.stale || res.error || !res.moves || !res.moves.length) return null;
  const s = res.moves[0].score;
  return { score: child.toMove === st.toMove ? s : -s, source: `Edax level ${level}` };
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
  const correct = r.score >= best;
  const key = book.recordKey(info.index);
  const undo = T.retrying ? null : { key, prev: srs.get(key) }; // lets Accept revert this record
  if (!T.retrying) {
    srs.record(key, lineSoFar(), T.lineColor, correct);
    T.line.total++; T.session.total++;
    if (correct) { T.line.correct++; T.session.correct++; }
  }
  renderTrainStats();

  if (correct) {
    T.retrying = false;
    const others = info.moves.filter((m) => m.sq < 64 && m.score === best && m.sq !== sq).map((m) => sqName(m.sq));
    setFeedback(`<b>${sqName(sq)} ${fmtScore(r.score)}</b>: correct.`
      + (others.length ? `<span class="sub">Also best: ${others.join(', ')}</span>` : ''), 'good');
    pushMove(sq);
    T.phase = 'trainer';
    T.timer = setTimeout(trainerTurn, 650);
    return;
  }

  // Wrong: show all scores for this position, mark the chosen square.
  T.phase = 'wrong';
  const list = bookList(st, info);
  if (!list.find((m) => m.sq === sq)) list.push({ sq, score: r.score });
  paintScores(list, false);
  cells[sq].classList.add('wrong');
  const bestMoves = info.moves.filter((m) => m.sq < 64 && m.score === best);
  for (const m of bestMoves) cells[m.sq].classList.add('right');
  setAnchor({ list, wrong: sq, right: bestMoves.map((m) => m.sq) });
  T.anchor.undo = undo;
  renderExplore();
  setFeedback(`<b>${sqName(sq)} ${fmtScore(r.score)}</b> loses ${best - r.score} disc${best - r.score === 1 ? '' : 's'}.`
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
  }
  renderTrainStats();
  T.retrying = false;
  T.phase = 'trainer';
  setFeedback(`<b>${sqName(sq)}</b>: accepted.<span class="sub">Not saved for review.</span>`, 'good');
  pushMove(sq);
  T.timer = setTimeout(trainerTurn, 650);
};
$('btn-train-best').onclick = () => {
  restoreAnchor();
  const info = probe(cur());
  clearMarks();
  if (!info) return;
  const best = bestScore(info);
  const pick = info.moves.find((m) => m.sq < 64 && m.inBook && m.score === best) || info.moves.find((m) => m.sq < 64 && m.score === best);
  T.retrying = false;
  T.phase = 'trainer';
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
