// Small 2D geometry toolkit (mm units throughout).

export interface Pt {
  x: number;
  y: number;
}
export interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function dist(a: Pt, b: Pt): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
export function dist2(a: Pt, b: Pt): number {
  const dx = a.x - b.x, dy = a.y - b.y;
  return dx * dx + dy * dy;
}
export function add(a: Pt, b: Pt): Pt {
  return { x: a.x + b.x, y: a.y + b.y };
}
export function sub(a: Pt, b: Pt): Pt {
  return { x: a.x - b.x, y: a.y - b.y };
}
export function mid(a: Pt, b: Pt): Pt {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

// Rotate point (deg, CCW screen-down is KiCad convention) around origin.
export function rotate(p: Pt, deg: number): Pt {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r), s = Math.sin(r);
  return { x: p.x * c - p.y * s, y: p.x * s + p.y * c };
}

// Apply a footprint/symbol placement (translation + rotation) to a local offset.
export function place(local: Pt, at: Pt, rotDeg: number): Pt {
  const r = rotate(local, rotDeg);
  return { x: at.x + r.x, y: at.y + r.y };
}

export function emptyBox(): Box {
  return { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
}
export function extend(b: Box, p: Pt): void {
  if (p.x < b.minX) b.minX = p.x;
  if (p.y < b.minY) b.minY = p.y;
  if (p.x > b.maxX) b.maxX = p.x;
  if (p.y > b.maxY) b.maxY = p.y;
}
export function boxW(b: Box): number {
  return b.maxX - b.minX;
}
export function boxH(b: Box): number {
  return b.maxY - b.minY;
}
export function boxCenter(b: Box): Pt {
  return { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 };
}
// Overlap area of two boxes (0 if disjoint).
export function boxOverlap(a: Box, b: Box): number {
  const w = Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX);
  const h = Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY);
  if (w <= 0 || h <= 0) return 0;
  return w * h;
}
export function boxInflate(b: Box, m: number): Box {
  return { minX: b.minX - m, minY: b.minY - m, maxX: b.maxX + m, maxY: b.maxY + m };
}
// Shortest edge-to-edge distance between two axis-aligned boxes (0 if overlapping/touching).
export function boxGap(a: Box, b: Box): number {
  const dx = Math.max(a.minX - b.maxX, b.minX - a.maxX, 0);
  const dy = Math.max(a.minY - b.maxY, b.minY - a.maxY, 0);
  return Math.hypot(dx, dy);
}
export function pointInBox(p: Pt, b: Box): boolean {
  return p.x >= b.minX && p.x <= b.maxX && p.y >= b.minY && p.y <= b.maxY;
}
// Shortest distance from a point to the nearest point on/in a box (0 if inside).
export function pointBoxDist(p: Pt, b: Box): number {
  const dx = Math.max(b.minX - p.x, 0, p.x - b.maxX);
  const dy = Math.max(b.minY - p.y, 0, p.y - b.maxY);
  return Math.hypot(dx, dy);
}

// Segment intersection test (proper crossing).
export function segIntersect(p1: Pt, p2: Pt, p3: Pt, p4: Pt): boolean {
  const d = (a: Pt, b: Pt, c: Pt) =>
    (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const d1 = d(p3, p4, p1);
  const d2 = d(p3, p4, p2);
  const d3 = d(p1, p2, p3);
  const d4 = d(p1, p2, p4);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
      ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
  return false;
}

// Shortest distance from point to segment.
export function pointSegDist(p: Pt, a: Pt, b: Pt): number {
  const l2 = dist2(a, b);
  if (l2 === 0) return dist(p, a);
  let t = ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / l2;
  t = Math.max(0, Math.min(1, t));
  return dist(p, { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) });
}

// Area of a polygon (shoelace, absolute).
export function polyArea(pts: Pt[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length;
    a += pts[i].x * pts[j].y - pts[j].x * pts[i].y;
  }
  return Math.abs(a) / 2;
}
export function centroid(pts: Pt[]): Pt {
  let x = 0, y = 0;
  for (const p of pts) { x += p.x; y += p.y; }
  return { x: x / pts.length, y: y / pts.length };
}
