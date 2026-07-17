import type { GraphNode, GraphEdge } from "../data";

// Deterministic 2D layout of the netlist graph for the LEFT panel.
// Attractive edges (k>0) pull; repulsive edges (k<0) and global charge push.
// Seeded, fixed iteration count -> identical every render (frame-stable).
export function forceLayout(nodes: GraphNode[], edges: GraphEdge[], w: number, h: number) {
  const n = nodes.length;
  // seeded ring start (golden-angle) so it's spread + deterministic
  const P = nodes.map((_, i) => ({
    x: w / 2 + Math.cos(i * 2.39996) * (w * 0.32),
    y: h / 2 + Math.sin(i * 2.39996) * (h * 0.32),
    vx: 0, vy: 0,
  }));
  const ITER = n > 120 ? 140 : 240;
  for (let it = 0; it < ITER; it++) {
    const fx = new Array(n).fill(0), fy = new Array(n).fill(0);
    // repulsion between all
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
      let dx = P[i].x - P[j].x, dy = P[i].y - P[j].y;
      let d2 = dx * dx + dy * dy + 0.01; const d = Math.sqrt(d2);
      const rep = 9000 / d2;
      fx[i] += (dx / d) * rep; fy[i] += (dy / d) * rep;
      fx[j] -= (dx / d) * rep; fy[j] -= (dy / d) * rep;
    }
    // edge springs
    for (const e of edges) {
      const a = P[e.i], b = P[e.j];
      let dx = b.x - a.x, dy = b.y - a.y; const d = Math.sqrt(dx * dx + dy * dy) + 0.01;
      const attract = e.k > 0 ? 0.012 * e.k : 0; // only attractive shape the layout
      const f = attract * (d - 90);
      fx[e.i] += (dx / d) * f; fy[e.i] += (dy / d) * f;
      fx[e.j] -= (dx / d) * f; fy[e.j] -= (dy / d) * f;
    }
    // gravity to center
    for (let i = 0; i < n; i++) {
      fx[i] += (w / 2 - P[i].x) * 0.01; fy[i] += (h / 2 - P[i].y) * 0.01;
      P[i].vx = (P[i].vx + fx[i]) * 0.82; P[i].vy = (P[i].vy + fy[i]) * 0.82;
      P[i].x += P[i].vx * 0.08; P[i].y += P[i].vy * 0.08;
    }
  }
  // normalize into box with margin
  const m = 54;
  const xs = P.map((p) => p.x), ys = P.map((p) => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  return P.map((p) => ({
    x: m + ((p.x - minX) / (maxX - minX || 1)) * (w - 2 * m),
    y: m + ((p.y - minY) / (maxY - minY || 1)) * (h - 2 * m),
  }));
}

// Monochrome role palette: gray shades by category + amber accent for power nodes.
export const roleColor: Record<string, string> = {
  mcu: "#d6d6d8", ic: "#d6d6d8", motor_driver: "#cacace", adc: "#cacace", imu: "#9a9aa0",
  regulator: "#c89a3c", inductor: "#c89a3c", mosfet: "#b0863a",
  input_cap: "#5e5e64", output_cap: "#5e5e64", decap: "#525258", resistor: "#4e4e54",
  usb: "#9a9aa0", connector: "#9a9aa0", antenna: "#c89a3c", rf: "#bfbfc4",
  diode: "#6c6c72", crystal: "#8a8a90", sensor: "#8a8a90", testpoint: "#46464c", led: "#6c6c72",
};
export const rc = (r: string) => roleColor[r] || "#6c6c72";
