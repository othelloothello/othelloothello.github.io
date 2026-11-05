// Reader for Edax opening books (book.dat), entirely in the browser.
//
// File layout (little endian), from Edax book.c:
//   header (42 bytes): u32 'EDAX', u32 'BOOK', u8 version, u8 release,
//     date {i16 year, i8 month, day, hour, minute, second, pad},
//     options {i32 level, n_empties, midgame_error, endcut_error, verbosity}, i32 n_nodes
//   position records, one after another:
//     u64 player, u64 opponent            (player = side to move; bit i = square i, a1 = 0)
//     u32 wins, draws, losses, lines
//     i16 value, lower, upper             (score of the position for the side to move)
//     u8 n_link, u8 level
//     n_link x {i8 score, u8 move}        (book moves, score for the side to move)
//     {i8 score, u8 move}                 (leaf: best move not in the book; move 65 = none)
// Each position is stored once, in one of its 8 symmetric orientations.

const MAGIC_EDAX = 0x45444158;
const MAGIC_BOOK = 0x424f4f4b;
const HEADER_SIZE = 42;
export const NOMOVE = 65;
export const PASS = 64;

// symmetry(x, s) exactly as Edax: bit 1 mirror columns, bit 2 mirror rows, bit 4 transpose.
const SYM = [];
for (let s = 0; s < 8; s++) {
  const t = new Uint8Array(64);
  for (let x = 0; x < 64; x++) {
    let y = x;
    if (s & 1) y ^= 7;
    if (s & 2) y ^= 56;
    if (s & 4) y = (y >> 3) | ((y & 7) << 3);
    t[x] = y;
  }
  SYM.push(t);
}
const symMove = (m, s) => (m < 64 ? SYM[s][m] : m);

function hash4(a, b, c, d) {
  let h = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13) ^ b, 0xc2b2ae35);
  h = Math.imul(h ^ (h >>> 16) ^ c, 0x27d4eb2f);
  h = Math.imul(h ^ (h >>> 15) ^ d, 0x165667b1);
  return (h ^ (h >>> 16)) >>> 0;
}

export class Book {
  constructor(buffer) {
    const dv = new DataView(buffer);
    if (buffer.byteLength < HEADER_SIZE || dv.getUint32(0, true) !== MAGIC_EDAX || dv.getUint32(4, true) !== MAGIC_BOOK) {
      throw new Error('Not an Edax opening book');
    }
    this.version = dv.getUint8(8);
    this.release = dv.getUint8(9);
    if (this.version !== 4) throw new Error(`Unsupported book version ${this.version}.${this.release}`);
    const pad = (n) => String(n).padStart(2, '0');
    this.date = `${dv.getInt16(10, true)}-${pad(dv.getInt8(12))}-${pad(dv.getInt8(13))} ${pad(dv.getInt8(14))}:${pad(dv.getInt8(15))}`;
    this.level = dv.getInt32(18, true);
    this.nEmpties = dv.getInt32(22, true);
    this.midgameError = dv.getInt32(26, true);
    this.endcutError = dv.getInt32(30, true);
    this.declaredNodes = dv.getInt32(38, true);

    // Index every record.
    const offsets = [];
    let off = HEADER_SIZE;
    const end = buffer.byteLength;
    while (off + 42 <= end) {
      const nLink = dv.getUint8(off + 38);
      const size = 40 + 2 * nLink + 2;
      if (off + size > end) break;
      offsets.push(off);
      off += size;
    }
    this.trailingBytes = end - off;
    this.offsets = Uint32Array.from(offsets);
    this.n = this.offsets.length;

    // Open-addressing hash table: board -> record index.
    let cap = 1;
    while (cap < this.n * 2) cap <<= 1;
    this.mask = cap - 1;
    this.table = new Int32Array(cap).fill(-1);
    for (let i = 0; i < this.n; i++) {
      const o = this.offsets[i];
      let h = hash4(dv.getUint32(o, true), dv.getUint32(o + 4, true), dv.getUint32(o + 8, true), dv.getUint32(o + 12, true)) & this.mask;
      while (this.table[h] !== -1) h = (h + 1) & this.mask;
      this.table[h] = i;
    }
    this.dv = dv;
  }

  static async fromFile(file) {
    return new Book(await file.arrayBuffer());
  }

  findWords(p0, p1, o0, o1) {
    const dv = this.dv;
    let h = hash4(p0, p1, o0, o1) & this.mask;
    for (;;) {
      const i = this.table[h];
      if (i === -1) return -1;
      const o = this.offsets[i];
      if (dv.getUint32(o, true) === p0 && dv.getUint32(o + 4, true) === p1 &&
          dv.getUint32(o + 8, true) === o0 && dv.getUint32(o + 12, true) === o1) return i;
      h = (h + 1) & this.mask;
    }
  }

  // board: 64-array (0 empty, 1 black, 2 white); toMove: 1 or 2.
  // Returns null if the position is not in the book, otherwise
  // { value, lower, upper, level, wins, draws, losses, lines, moves: [{ sq, score, inBook }], leaf }
  // Scores are from the side to move. moves are sorted best first; the leaf (best
  // non-book move) is included with inBook = false.
  probe(board, toMove) {
    for (let s = 0; s < 8; s++) {
      // Stored board B satisfies symmetry(B, s) == current, so B[x] = current[SYM[s][x]].
      const t = SYM[s];
      let p0 = 0, p1 = 0, o0 = 0, o1 = 0;
      for (let x = 0; x < 64; x++) {
        const v = board[t[x]];
        if (!v) continue;
        if (v === toMove) { if (x < 32) p0 |= 1 << x; else p1 |= 1 << (x - 32); }
        else { if (x < 32) o0 |= 1 << x; else o1 |= 1 << (x - 32); }
      }
      const i = this.findWords(p0 >>> 0, p1 >>> 0, o0 >>> 0, o1 >>> 0);
      if (i >= 0) return this.decode(i, s);
    }
    return null;
  }

  decode(i, s = 0) {
    const dv = this.dv, o = this.offsets[i];
    const nLink = dv.getUint8(o + 38);
    const moves = [];
    for (let k = 0; k < nLink; k++) {
      moves.push({ sq: symMove(dv.getUint8(o + 40 + 2 * k + 1), s), score: dv.getInt8(o + 40 + 2 * k), inBook: true });
    }
    const lo = o + 40 + 2 * nLink;
    const leafMove = dv.getUint8(lo + 1);
    const leaf = leafMove === NOMOVE ? null : { sq: symMove(leafMove, s), score: dv.getInt8(lo), inBook: false };
    if (leaf) moves.push(leaf);
    moves.sort((a, b) => b.score - a.score || (b.inBook - a.inBook));
    return {
      index: i,
      symmetry: s,
      wins: dv.getUint32(o + 16, true),
      draws: dv.getUint32(o + 20, true),
      losses: dv.getUint32(o + 24, true),
      lines: dv.getUint32(o + 28, true),
      value: dv.getInt16(o + 32, true),
      lower: dv.getInt16(o + 34, true),
      upper: dv.getInt16(o + 36, true),
      level: dv.getUint8(o + 39),
      nLink,
      moves,
      leaf,
    };
  }

  // Stable id of a position (same for all 8 symmetric orientations): its stored board.
  recordKey(i) {
    const dv = this.dv, o = this.offsets[i];
    let k = '';
    for (let j = 0; j < 16; j += 4) k += dv.getUint32(o + j, true).toString(16).padStart(8, '0');
    return k;
  }

  // Board of record i in stored orientation, as a 64-array with the side to move as black (1).
  recordBoard(i) {
    const dv = this.dv, o = this.offsets[i];
    const p = [dv.getUint32(o, true), dv.getUint32(o + 4, true)];
    const q = [dv.getUint32(o + 8, true), dv.getUint32(o + 12, true)];
    const b = new Array(64).fill(0);
    for (let x = 0; x < 64; x++) {
      const w = x >> 5, bit = 1 << (x & 31);
      if (p[w] & bit) b[x] = 1; else if (q[w] & bit) b[x] = 2;
    }
    return b;
  }
}
