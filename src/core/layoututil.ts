// Shared geometry helpers so placement, routing and scoring agree on coordinates.
import { Box, Pt, place as placeLocal, emptyBox, extend, dist } from "./geometry";
import { Design, Layout, Net, Placement } from "./types";

export function padLocal(design: Design, ref: string, padNum: string): Pt | null {
  const fp = design.footprints[ref];
  if (!fp) return null;
  const pad = fp.pads.find((p) => p.num === padNum);
  if (!pad) return null;
  return { x: pad.x, y: pad.y };
}

// Absolute world position of a pad given the current placement.
export function padWorld(design: Design, layout: Layout, ref: string, padNum: string): Pt | null {
  const pl = layout.placements[ref];
  const loc = padLocal(design, ref, padNum);
  if (!pl || !loc) return null;
  const mirrored = pl.side === "back" ? { x: -loc.x, y: loc.y } : loc;
  return placeLocal(mirrored, { x: pl.x, y: pl.y }, pl.rot);
}

// Component courtyard box in world coordinates.
export function courtyardWorld(design: Design, pl: Placement): Box {
  const fp = design.footprints[pl.ref];
  const b = emptyBox();
  if (!fp) return { minX: pl.x - 1, minY: pl.y - 1, maxX: pl.x + 1, maxY: pl.y + 1 };
  const c = fp.courtyard;
  const corners: Pt[] = [
    { x: c.minX, y: c.minY }, { x: c.maxX, y: c.minY },
    { x: c.maxX, y: c.maxY }, { x: c.minX, y: c.maxY },
  ];
  for (const corner of corners) {
    const m = pl.side === "back" ? { x: -corner.x, y: corner.y } : corner;
    extend(b, placeLocal(m, { x: pl.x, y: pl.y }, pl.rot));
  }
  return b;
}

export function compCenter(layout: Layout, ref: string): Pt | null {
  const pl = layout.placements[ref];
  return pl ? { x: pl.x, y: pl.y } : null;
}

// All world pad positions of a net (deduped by component+pad).
export function netPads(design: Design, layout: Layout, net: Net): Pt[] {
  const out: Pt[] = [];
  for (const pr of net.pins) {
    const w = padWorld(design, layout, pr.ref, pr.pad);
    if (w) out.push(w);
  }
  return out;
}

// Minimum spanning tree edges over a net's pads (the ratsnest).
export function mstEdges(pts: Pt[]): [Pt, Pt][] {
  if (pts.length < 2) return [];
  const n = pts.length;
  const inTree = new Array(n).fill(false);
  const best = new Array(n).fill(Infinity);
  const from = new Array(n).fill(-1);
  best[0] = 0;
  const edges: [Pt, Pt][] = [];
  for (let it = 0; it < n; it++) {
    let u = -1;
    for (let v = 0; v < n; v++) if (!inTree[v] && (u === -1 || best[v] < best[u])) u = v;
    if (u === -1) break;
    inTree[u] = true;
    if (from[u] >= 0) edges.push([pts[from[u]], pts[u]]);
    for (let v = 0; v < n; v++) {
      if (inTree[v]) continue;
      const d = dist(pts[u], pts[v]);
      if (d < best[v]) { best[v] = d; from[v] = u; }
    }
  }
  return edges;
}

export function netByName(design: Design, name: string): Net | undefined {
  return design.nets.find((n) => n.name === name);
}

// Board-area sanity: keep a placement inside the board outline (with margin).
export function clampToBoard(design: Design, pl: Placement, margin = 2): Placement {
  const fp = design.footprints[pl.ref];
  const halfW = fp ? Math.max(fp.bodyW, fp.courtyard.maxX - fp.courtyard.minX) / 2 : 1;
  const halfH = fp ? Math.max(fp.bodyH, fp.courtyard.maxY - fp.courtyard.minY) / 2 : 1;
  const minX = margin + halfW, maxX = design.board.width - margin - halfW;
  const minY = margin + halfH, maxY = design.board.height - margin - halfH;
  return {
    ...pl,
    x: Math.min(Math.max(pl.x, minX), Math.max(minX, maxX)),
    y: Math.min(Math.max(pl.y, minY), Math.max(minY, maxY)),
  };
}
