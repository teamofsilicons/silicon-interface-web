// Deterministic MarkSystem generator for Carbon, Silicon, and Team marks.
// Ported from /Users/codanium/Downloads/MarkSystem (1).jsx.

const BG = "#EAE6DD";
const FG = "#111111";
const VB = 100;

type Family = "carbon" | "silicon" | "team";
type CellType = 0 | 1 | 2 | 3 | 4 | 5;
type Transform = [(r: number, c: number, n: number) => [number, number], (t: CellType) => CellType];

function remapCell(t: CellType, map: Partial<Record<CellType, CellType>>): CellType {
  return map[t] ?? t;
}

const flipH = (t: CellType): CellType => remapCell(t, { 2: 3, 3: 2, 4: 5, 5: 4 });
const flipV = (t: CellType): CellType => remapCell(t, { 2: 5, 5: 2, 3: 4, 4: 3 });
const flipD = (t: CellType): CellType => remapCell(t, { 3: 5, 5: 3 });
const flipA = (t: CellType): CellType => remapCell(t, { 2: 4, 4: 2 });
const rot90 = (t: CellType): CellType => remapCell(t, { 2: 3, 3: 4, 4: 5, 5: 2 });
const rot270 = (t: CellType): CellType => remapCell(t, { 2: 5, 5: 4, 4: 3, 3: 2 });
const rot180 = (t: CellType): CellType => remapCell(t, { 2: 4, 4: 2, 3: 5, 5: 3 });

const T = {
  id: [(r: number, c: number) => [r, c] as [number, number], (t: CellType) => t] as Transform,
  mH: [(r: number, c: number, n: number) => [r, n - 1 - c] as [number, number], flipH] as Transform,
  mV: [(r: number, c: number, n: number) => [n - 1 - r, c] as [number, number], flipV] as Transform,
  r180: [(r: number, c: number, n: number) => [n - 1 - r, n - 1 - c] as [number, number], rot180] as Transform,
  mD: [(r: number, c: number) => [c, r] as [number, number], flipD] as Transform,
  mA: [(r: number, c: number, n: number) => [n - 1 - c, n - 1 - r] as [number, number], flipA] as Transform,
  r90: [(r: number, c: number, n: number) => [c, n - 1 - r] as [number, number], rot90] as Transform,
  r270: [(r: number, c: number, n: number) => [n - 1 - c, r] as [number, number], rot270] as Transform,
};

const ORTHO = [T.id, T.mH, T.mV, T.r180];
const DIAG = [T.id, T.mD, T.mA, T.r180];
const FULL8 = [T.id, T.mH, T.mV, T.r180, T.mD, T.mA, T.r90, T.r270];

interface DomainCell {
  r: number;
  c: number;
  rad: number;
  ang: number;
}

function fnv(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function mulberry32(a: number) {
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildDomain(n: number, pred: (r: number, c: number, cen: number, n: number) => boolean): DomainCell[] {
  const cen = (n - 1) / 2;
  const out: DomainCell[] = [];
  for (let r = 0; r < n; r += 1) {
    for (let c = 0; c < n; c += 1) {
      if (pred(r, c, cen, n)) out.push({ r, c, rad: Math.hypot(r - cen, c - cen), ang: Math.atan2(r - cen, c - cen) });
    }
  }
  out.sort((a, b) => a.rad - b.rad || a.ang - b.ang || a.r - b.r);
  return out;
}

const SOLID = 0;
const DIN = 1;
const DOUT = 2;
const SPARSE = 3;
const ALT = 4;
const GAP = 5;

function ringTreatment(next: () => number, ring: number): number {
  const r = next();
  if (ring <= 1) {
    if (r < 0.5) return SOLID;
    if (r < 0.85) return DIN;
    return DOUT;
  }
  if (r < 0.26) return SOLID;
  if (r < 0.44) return DIN;
  if (r < 0.58) return DOUT;
  if (r < 0.77) return SPARSE;
  if (r < 0.9) return ALT;
  return GAP;
}

function cellType(
  treatment: number,
  r: number,
  c: number,
  fillBias: number,
  parity: number,
  cellRng: () => number,
): CellType {
  switch (treatment) {
    case SOLID:
      return 1;
    case DIN:
      return 4;
    case DOUT:
      return 2;
    case ALT:
      return ((r + c) & 1) === parity ? 1 : 0;
    case SPARSE:
      return cellRng() < fillBias ? (cellRng() < 0.7 ? 1 : 4) : 0;
    default:
      return 0;
  }
}

const FAM = {
  carbon: {
    n: 7,
    group: ORTHO,
    theme: "light",
    domain: buildDomain(7, (r, c, cen) => r <= cen && c <= cen),
  },
  silicon: {
    n: 7,
    group: DIAG,
    theme: "dark",
    domain: buildDomain(7, (r, c, cen, n) => r <= c && r <= n - 1 - c),
  },
  team: {
    n: 9,
    group: FULL8,
    theme: "split",
    domain: buildDomain(9, (r, c, cen) => r <= cen && c <= cen && r <= c),
  },
} satisfies Record<Family, {
  n: number;
  group: Transform[];
  theme: "light" | "dark" | "split";
  domain: DomainCell[];
}>;

function buildGrid(text: string, fam: Family): CellType[][] {
  const config = FAM[fam];
  const grid: CellType[][] = Array.from({ length: config.n }, () => Array<CellType>(config.n).fill(0));
  const source = (text || "?").slice(0, 28);
  const chars = [...source];
  if (chars.length === 0) return grid;

  const seed = fnv(source);
  const next = mulberry32(seed);
  const fillBias = 0.42 + next() * 0.42;
  const parity = next() < 0.5 ? 0 : 1;
  const centerType: CellType = next() < 0.78 ? 1 : 0;
  const maxRing = Math.round(Math.max(...config.domain.map((d) => d.rad)));
  const ringTreatments = Array.from({ length: maxRing + 1 }, (_, ring) => ringTreatment(next, ring));
  const count = Math.min(chars.length, config.domain.length);

  for (let i = 0; i < count; i += 1) {
    const cell = config.domain[i];
    const ring = Math.round(cell.rad);
    const cellRng = mulberry32((seed ^ Math.imul(cell.r + 1, 73856093) ^ Math.imul(cell.c + 1, 19349663)) >>> 0);
    const t = ring === 0 ? centerType : cellType(ringTreatments[ring], cell.r, cell.c, fillBias, parity, cellRng);
    config.group.forEach(([fn, tt]) => {
      const [r2, c2] = fn(cell.r, cell.c, config.n);
      grid[r2][c2] = tt(t);
    });
  }
  return grid;
}

function cellMarkup(grid: CellType[][], n: number, fill: string): string {
  const pad = 8;
  const s = (VB - pad * 2) / n;
  const e = 0.4;
  let out = "";
  grid.forEach((row, r) => row.forEach((t, c) => {
    if (!t) return;
    const x0 = pad + c * s - e;
    const y0 = pad + r * s - e;
    const x1 = pad + c * s + s + e;
    const y1 = pad + r * s + s + e;
    if (t === 1) {
      out += `<rect x="${x0}" y="${y0}" width="${x1 - x0}" height="${y1 - y0}" fill="${fill}"/>`;
      return;
    }
    let points = "";
    if (t === 2) points = `${x0},${y0} ${x1},${y0} ${x0},${y1}`;
    else if (t === 3) points = `${x0},${y0} ${x1},${y0} ${x1},${y1}`;
    else if (t === 4) points = `${x1},${y1} ${x0},${y1} ${x1},${y0}`;
    else points = `${x0},${y1} ${x0},${y0} ${x1},${y1}`;
    out += `<polygon points="${points}" fill="${fill}"/>`;
  }));
  return out;
}

export interface GlyphOptions {
  size?: number;
  family?: Family;
}

// Delights §0b — render the *generated* MarkSystem mark as ASCII. Shares the
// exact same grid as `glyphSvg`, so a user's two representations are visually
// consistent: same identity, different render target. Cell types map to:
//   0→space  1→full block  2/3/4/5→the four corner triangles ◤◥◢◣
const ASCII_CELL: Record<CellType, string> = { 0: " ", 1: "█", 2: "◤", 3: "◥", 4: "◢", 5: "◣" };

/** The MarkSystem mark for `text` as an ASCII grid (newline-separated rows). */
export function glyphAscii(text: string, opts: { family?: Family } = {}): string {
  const grid = buildGrid(text || "?", opts.family ?? "carbon");
  return grid.map((row) => row.map((t) => ASCII_CELL[t]).join("")).join("\n");
}

export function glyphSvg(text: string, opts: GlyphOptions = {}): string {
  const family = opts.family ?? "carbon";
  const size = opts.size ?? 256;
  const config = FAM[family];
  const grid = buildGrid(text || "?", family);
  const id = `ms-${family}-${fnv(`${family}:${text || "?"}`).toString(36)}`;

  let body = "";
  if (config.theme === "split") {
    const h = VB / 2;
    body = [
      `<defs><clipPath id="${id}-lh"><rect x="0" y="0" width="${h}" height="${VB}"/></clipPath><clipPath id="${id}-rh"><rect x="${h}" y="0" width="${h}" height="${VB}"/></clipPath></defs>`,
      `<rect x="0" y="0" width="${h}" height="${VB}" fill="${BG}"/>`,
      `<rect x="${h}" y="0" width="${h}" height="${VB}" fill="${FG}"/>`,
      `<g clip-path="url(#${id}-lh)">${cellMarkup(grid, config.n, FG)}</g>`,
      `<g clip-path="url(#${id}-rh)">${cellMarkup(grid, config.n, BG)}</g>`,
    ].join("");
  } else {
    const dark = config.theme === "dark";
    body = `<rect width="${VB}" height="${VB}" fill="${dark ? FG : BG}"/>${cellMarkup(grid, config.n, dark ? BG : FG)}`;
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${VB} ${VB}" width="${size}" height="${size}" style="display:block;width:${size}px;height:${size}px">${body}</svg>`;
}
