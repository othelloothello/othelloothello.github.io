// Reversi rules. Squares are 0..63, index = row * 8 + col, a1 = 0 (top-left), h8 = 63.
export const EMPTY = 0, BLACK = 1, WHITE = 2;
export const opp = (p) => 3 - p;

const DIRS = [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]];

export const sqName = (s) => 'abcdefgh'[s & 7] + ((s >> 3) + 1);
export const parseSq = (t) => {
  const m = /^([a-h])([1-8])$/i.exec(t.trim());
  return m ? (Number(m[2]) - 1) * 8 + (m[1].toLowerCase().charCodeAt(0) - 97) : -1;
};

export function initialBoard() {
  const b = new Array(64).fill(EMPTY);
  b[27] = WHITE; b[36] = WHITE; // d4, e5
  b[28] = BLACK; b[35] = BLACK; // e4, d5
  return b;
}

export function flipsFor(b, sq, p) {
  if (b[sq] !== EMPTY) return [];
  const r = sq >> 3, c = sq & 7, o = opp(p), res = [];
  for (const [dr, dc] of DIRS) {
    let rr = r + dr, cc = c + dc;
    const line = [];
    while (rr >= 0 && rr < 8 && cc >= 0 && cc < 8 && b[rr * 8 + cc] === o) {
      line.push(rr * 8 + cc); rr += dr; cc += dc;
    }
    if (line.length && rr >= 0 && rr < 8 && cc >= 0 && cc < 8 && b[rr * 8 + cc] === p) res.push(...line);
  }
  return res;
}

export function legalMoves(b, p) {
  const m = [];
  for (let s = 0; s < 64; s++) if (b[s] === EMPTY && flipsFor(b, s, p).length) m.push(s);
  return m;
}

export function countDiscs(b) {
  let black = 0, white = 0;
  for (const v of b) { if (v === BLACK) black++; else if (v === WHITE) white++; }
  return { black, white };
}

// A state is the position after a move.
// { board, toMove, move, mover, flips, passed, over }
// passed: the player who would normally move next had to pass.
export function initialState() {
  return { board: initialBoard(), toMove: BLACK, move: -1, mover: 0, flips: [], passed: false, over: false };
}

export function playMove(st, sq) {
  if (st.over) return null;
  const p = st.toMove;
  const flips = flipsFor(st.board, sq, p);
  if (!flips.length) return null;
  const board = st.board.slice();
  board[sq] = p;
  for (const f of flips) board[f] = p;
  let toMove = opp(p), passed = false, over = false;
  if (!legalMoves(board, toMove).length) {
    if (legalMoves(board, p).length) { toMove = p; passed = true; }
    else over = true;
  }
  return { board, toMove, move: sq, mover: p, flips, passed, over };
}

// Parse a transcript like "f5d6c3d3c4" (separators and case ignored).
export function parseTranscript(text) {
  const tokens = (text.toLowerCase().match(/[a-h][1-8]/g)) || [];
  const states = [initialState()];
  for (let i = 0; i < tokens.length; i++) {
    const next = playMove(states[states.length - 1], parseSq(tokens[i]));
    if (!next) return { states, error: `Move ${i + 1} (${tokens[i]}) is not legal` };
    states.push(next);
  }
  return { states, error: null };
}
