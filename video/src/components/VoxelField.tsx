import React from "react";
import { useCurrentFrame } from "remotion";
import type { EmiLevel } from "../data";
import { theme } from "../theme";

// Monochrome heat ramp: dark gray -> light gray -> (hottest) amber accent.
function heat(v: number): string {
  const stops = [
    [0.0, [30, 30, 33]],
    [0.3, [104, 104, 108]],
    [0.6, [176, 176, 180]],
    [0.85, [234, 234, 236]],
    [1.0, [214, 160, 58]],
  ] as const;
  let a = stops[0], b = stops[stops.length - 1];
  for (let i = 0; i < stops.length - 1; i++) {
    if (v >= stops[i][0] && v <= stops[i + 1][0]) { a = stops[i]; b = stops[i + 1]; break; }
  }
  const t = (v - a[0]) / Math.max(1e-6, b[0] - a[0]);
  const c = a[1].map((x, i) => Math.round(x + (b[1][i] - x) * t));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

// Real EMI field grid drawn as voxels. The ONLY animated element: a subtle
// temporal fluctuation of cell intensity (the damped wave "breathing").
export const VoxelField: React.FC<{
  level: EmiLevel; boardW: number; boardH: number;
  width: number; height: number; showGrid?: boolean; gamma?: number; fluctuate?: boolean;
}> = ({ level, boardW, boardH, width, height, showGrid = true, gamma = 0.8, fluctuate = true }) => {
  const f = useCurrentFrame();
  const { w, h, data } = level;
  const pad = 10;
  const sc = Math.min((width - pad * 2) / boardW, (height - pad * 2) / boardH);
  const bw = boardW * sc, bh = boardH * sc;
  const ox = (width - bw) / 2, oy = (height - bh) / 2;
  const cw = bw / w, ch = bh / h;
  const max = Math.max(1e-6, ...data);

  const cells: React.ReactNode[] = [];
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      const idx = r * w + c;
      let v = Math.pow((data[idx] || 0) / max, gamma);
      if (v < 0.015) continue;
      if (fluctuate) v *= 0.82 + 0.18 * Math.sin(f * 0.22 + (c + r) * 0.45 + v * 5);
      cells.push(
        <rect key={idx} x={ox + c * cw} y={oy + r * ch} width={cw + 0.6} height={ch + 0.6}
          fill={heat(v)} opacity={Math.min(0.96, 0.32 + v * 0.68)} />
      );
    }
  }
  const gridStep = Math.max(1, Math.round(w / 40)); // thin out gridlines for fine grids
  return (
    <svg width={width} height={height} style={{ position: "absolute", left: 0, top: 0 }}>
      <rect x={ox} y={oy} width={bw} height={bh} fill="#080809" stroke={theme.panelStroke} strokeWidth={1} />
      {cells}
      {showGrid && Array.from({ length: Math.floor(w / gridStep) + 1 }).map((_, i) => (
        <line key={"v" + i} x1={ox + i * gridStep * cw} y1={oy} x2={ox + i * gridStep * cw} y2={oy + bh} stroke={theme.bg} strokeWidth={0.5} opacity={0.3} />
      ))}
      {showGrid && Array.from({ length: Math.floor(h / gridStep) + 1 }).map((_, i) => (
        <line key={"h" + i} x1={ox} y1={oy + i * gridStep * ch} x2={ox + bw} y2={oy + i * gridStep * ch} stroke={theme.bg} strokeWidth={0.5} opacity={0.3} />
      ))}
    </svg>
  );
};
