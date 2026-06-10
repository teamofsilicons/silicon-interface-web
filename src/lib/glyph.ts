// Deterministic MarkSystem generator for Carbon, Silicon, and Team marks.
// Ported from /Users/codanium/Downloads/MarkSystem (2).jsx — v2 adds capped
// complexity (BUDGET), a quality gate that demands real shape across up to 12
// deterministic attempts, harder negative-space ring treatments, and a base-4
// "seed register" strip engraved along the bottom edge.

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

function ringTreatment(next: () => number, ring: number, maxRing: number): number {
  const r = next();
  if (ring <= 1) {
    if (r < 0.5) return SOLID;
    if (r < 0.85) return DIN;
    return DOUT;
  }
  // outer rings lean hard into negative space → marks stay minimal
  const outer = ring / maxRing; // 0..1
  if (r < 0.14 - outer * 0.08) return SOLID;
  if (r < 0.3) return DIN;
  if (r < 0.42) return DOUT;
  if (r < 0.52) return SPARSE;
  if (r < 0.58) return ALT;
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

function buildGrid(text: string, fam: Family, seedNum: number): CellType[][] {
  const { n: N, group, domain } = FAM[fam];
  const chars = [...(text || "")];
  const empty = () => Array.from({ length: N }, () => Array<CellType>(N).fill(0));
  if (chars.length === 0) return empty();

  const baseSeed = (fnv(text) ^ Math.imul(seedNum + 1, 0x9e3779b1)) >>> 0;
  const maxRing = Math.round(Math.max(...domain.map((d) => d.rad)));
  // Minimal by design — complexity is capped regardless of length.
  const budget = Math.ceil(domain.length * 0.45);
  const count = Math.min(chars.length, budget);

  const compose = (attempt: number) => {
    const g = empty();
    const seed = (baseSeed ^ Math.imul(attempt, 0x85ebca6b)) >>> 0;
    const next = mulberry32(seed);
    const fillBias = 0.22 + next() * 0.2;
    const parity = next() < 0.5 ? 0 : 1;
    const centerType: CellType = next() < 0.78 ? 1 : 0;
    const ringTreatments = Array.from({ length: maxRing + 1 }, (_, ring) => ringTreatment(next, ring, maxRing));

    let outer = 0; // cells placed beyond the inner ring
    let tris = 0; // angled (triangle) cells
    for (let i = 0; i < count; i += 1) {
      const cell = domain[i];
      const ring = Math.round(cell.rad);
      let t: CellType;
      if (ring === 0) t = centerType;
      else {
        const cellRng = mulberry32((seed ^ Math.imul(cell.r + 1, 73856093) ^ Math.imul(cell.c + 1, 19349663)) >>> 0);
        t = cellType(ringTreatments[ring], cell.r, cell.c, fillBias, parity, cellRng);
      }
      if (t && cell.rad > 1.6) outer += 1;
      if (t >= 2 && t <= 5) tris += 1;
      group.forEach(([fn, tt]) => {
        const [r2, c2] = fn(cell.r, cell.c, N);
        g[r2][c2] = tt(t);
      });
    }
    return { g, outer, tris };
  };

  // Quality gate: a mark must have shape, not just a blob. Demand presence
  // beyond the inner ring and at least one angled cell. Deterministic — the
  // same text + seed always walks the same attempts.
  const revealed = Math.max(0, count - 4);
  const needOuter = Math.min(2, revealed);
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const { g, outer, tris } = compose(attempt);
    if (outer >= needOuter && (tris >= 1 || count <= 2)) return g;
  }
  return compose(0).g;
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

// The seed is engraved into the mark as a base-4 strip of micro-glyphs along
// the bottom edge (0 = square · 1 = diamond · 2 = hollow · 3 = triangle), so
// two different seeds can never collide. The app's marks are deterministic per
// identity, so we derive the seed from the text itself; the modulus keeps the
// register strip short.
function seedFor(text: string): number {
  return fnv(text) % 4096;
}

function base4(n: number): number[] {
  let v = Math.max(0, Math.floor(n));
  if (v === 0) return [0];
  const d: number[] = [];
  while (v > 0) {
    d.unshift(v % 4);
    v = Math.floor(v / 4);
  }
  return d;
}

function seedStripMarkup(seed: number, paint: string): string {
  const digits = base4(seed);
  const u = 2.4; // glyph size
  const gap = 1.5; // spacing
  const w = digits.length * u + (digits.length - 1) * gap;
  const x0 = (VB - w) / 2;
  const cy = VB - 4.2;
  let out = "";
  digits.forEach((d, i) => {
    const x = x0 + i * (u + gap);
    const cx = x + u / 2;
    const h = u / 2;
    if (d === 0) out += `<rect x="${x}" y="${cy - h}" width="${u}" height="${u}" fill="${paint}"/>`;
    else if (d === 1) out += `<polygon points="${cx},${cy - h} ${x + u},${cy} ${cx},${cy + h} ${x},${cy}" fill="${paint}"/>`;
    else if (d === 2) out += `<rect x="${x + 0.35}" y="${cy - h + 0.35}" width="${u - 0.7}" height="${u - 0.7}" fill="none" stroke="${paint}" stroke-width="0.7"/>`;
    else out += `<polygon points="${cx},${cy - h} ${x + u},${cy + h} ${x},${cy + h}" fill="${paint}"/>`;
  });
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
  const src = text || "?";
  const grid = buildGrid(src, opts.family ?? "carbon", seedFor(src));
  return grid.map((row) => row.map((t) => ASCII_CELL[t]).join("")).join("\n");
}

export function glyphSvg(text: string, opts: GlyphOptions = {}): string {
  const family = opts.family ?? "carbon";
  const size = opts.size ?? 256;
  const config = FAM[family];
  const src = text || "?";
  const seedNum = seedFor(src);
  const grid = buildGrid(src, family, seedNum);
  const id = `ms-${family}-${fnv(`${family}:${src}`).toString(36)}`;

  let body = "";
  if (config.theme === "split") {
    const h = VB / 2;
    body = [
      `<defs><clipPath id="${id}-lh"><rect x="0" y="0" width="${h}" height="${VB}"/></clipPath><clipPath id="${id}-rh"><rect x="${h}" y="0" width="${h}" height="${VB}"/></clipPath></defs>`,
      `<rect x="0" y="0" width="${h}" height="${VB}" fill="${BG}"/>`,
      `<rect x="${h}" y="0" width="${h}" height="${VB}" fill="${FG}"/>`,
      `<g clip-path="url(#${id}-lh)">${cellMarkup(grid, config.n, FG)}${seedStripMarkup(seedNum, FG)}</g>`,
      `<g clip-path="url(#${id}-rh)">${cellMarkup(grid, config.n, BG)}${seedStripMarkup(seedNum, BG)}</g>`,
    ].join("");
  } else {
    const dark = config.theme === "dark";
    body = `<rect width="${VB}" height="${VB}" fill="${dark ? FG : BG}"/>${cellMarkup(grid, config.n, dark ? BG : FG)}${seedStripMarkup(seedNum, dark ? BG : FG)}`;
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${VB} ${VB}" width="${size}" height="${size}" style="display:block;width:${size}px;height:${size}px">${body}</svg>`;
}
