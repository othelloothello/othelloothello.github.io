// Training helpers: spaced repetition store and opponent move choice.

const MIN = 60e3, DAY = 864e5;
// Leitner boxes: a miss goes to box 0 (back in about a minute); each correct review moves up one box.
export const INTERVALS = [1 * MIN, 1 * DAY, 3 * DAY, 7 * DAY, 21 * DAY, 60 * DAY];

export class Repetition {
  constructor(storageKey = 'ot.srs') {
    this.storageKey = storageKey;
    this.items = {};
    try { this.items = JSON.parse(localStorage.getItem(storageKey) || '{}') || {}; } catch { this.items = {}; }
  }

  save() {
    try { localStorage.setItem(this.storageKey, JSON.stringify(this.items)); } catch { /* storage full or blocked */ }
  }

  // key: book position id; line: transcript reaching it; color: side the user plays there (1/2).
  record(key, line, color, correct, now = Date.now()) {
    const it = this.items[key];
    if (!correct) {
      this.items[key] = { line, color, box: 0, due: now + INTERVALS[0], misses: (it ? it.misses : 0) + 1, last: now };
      this.save();
      return;
    }
    if (it && it.due <= now) {
      it.box = Math.min(it.box + 1, INTERVALS.length - 1);
      it.due = now + INTERVALS[it.box];
      it.last = now;
      this.save();
    }
  }

  // colors: array of allowed colors, e.g. [1] or [1, 2]
  due(colors, now = Date.now()) {
    return Object.entries(this.items)
      .filter(([, it]) => it.due <= now && colors.includes(it.color))
      .sort((a, b) => a[1].due - b[1].due)
      .map(([key, it]) => ({ key, ...it }));
  }

  count(colors) {
    const all = Object.values(this.items).filter((it) => colors.includes(it.color));
    return { total: all.length, due: all.filter((it) => it.due <= Date.now()).length };
  }

  clear() { this.items = {}; this.save(); }
}

// Book moves (not the leaf) within `margin` discs of the best book move.
export function opponentCandidates(info, margin) {
  const links = info.moves.filter((m) => m.inBook && m.sq < 64);
  if (!links.length) return [];
  const best = Math.max(...links.map((m) => m.score));
  return links.filter((m) => m.score >= best - margin);
}

export const pickRandom = (arr) => arr[Math.floor(Math.random() * arr.length)];
