import React from "react";
import { interpolate } from "remotion";
import type { HistRec } from "../data";
import { theme } from "../theme";

// Animated monotonic "ratchet" curve from real iteration history.
// raw score per iter (faint) + best-so-far (bold, non-increasing) + substrate marks.
export const LearningCurve: React.FC<{
  history: HistRec[]; width: number; height: number; reveal: number; // 0..1
}> = ({ history, width, height, reveal }) => {
  const pad = { l: 60, r: 24, t: 28, b: 40 };
  const iw = width - pad.l - pad.r, ih = height - pad.t - pad.b;
  const raws = history.map((h) => h.rawScore), bests = history.map((h) => h.bestScore);
  const yMax = Math.max(...raws) * 1.05, yMin = Math.min(...bests) * 0.9;
  const X = (i: number) => pad.l + (i / (history.length - 1)) * iw;
  const Y = (v: number) => pad.t + (1 - (v - yMin) / (yMax - yMin)) * ih;
  const shown = interpolate(reveal, [0, 1], [0, history.length - 1]);

  const linePath = (vals: number[]) => vals.map((v, i) => `${i === 0 ? "M" : "L"} ${X(i)} ${Y(v)}`).join(" ");
  // clip to shown progress via dasharray
  const total = 4000;
  const off = (1 - interpolate(reveal, [0, 1], [0, 1])) * total;

  return (
    <svg width={width} height={height}>
      {/* axes */}
      <line x1={pad.l} y1={pad.t} x2={pad.l} y2={pad.t + ih} stroke={theme.panelStroke} strokeWidth={1} />
      <line x1={pad.l} y1={pad.t + ih} x2={pad.l + iw} y2={pad.t + ih} stroke={theme.panelStroke} strokeWidth={1} />
      {[0, 0.5, 1].map((g) => (
        <line key={g} x1={pad.l} y1={pad.t + g * ih} x2={pad.l + iw} y2={pad.t + g * ih} stroke={theme.gridFaint} strokeWidth={1} />
      ))}
      {/* raw score (exploration) */}
      <path d={linePath(raws)} fill="none" stroke={theme.inkFaint} strokeWidth={1.5} strokeDasharray={`${total}`} strokeDashoffset={off} opacity={0.7} />
      {raws.map((v, i) => i <= shown && <circle key={i} cx={X(i)} cy={Y(v)} r={3} fill={theme.inkFaint} opacity={0.7} />)}
      {/* best-so-far ratchet */}
      <path d={linePath(bests)} fill="none" stroke={theme.cyan} strokeWidth={3.5} strokeDasharray={`${total}`} strokeDashoffset={off} />
      {/* substrate promotions */}
      {history.map((h, i) => {
        const sub = (h.promoted || []).find((p) => /substrate v/i.test(p));
        if (!sub || i > shown) return null;
        return (
          <g key={i}>
            <circle cx={X(i)} cy={Y(h.bestScore)} r={6} fill={theme.green} stroke={theme.bg} strokeWidth={2} />
            <text x={X(i)} y={Y(h.bestScore) - 14} textAnchor="middle" fontFamily={theme.mono} fontSize={13} fill={theme.green}>{sub.match(/v\d+/)?.[0]}</text>
          </g>
        );
      })}
      <text x={pad.l - 10} y={Y(yMax) + 4} textAnchor="end" fontFamily={theme.mono} fontSize={12} fill={theme.inkDim}>{Math.round(yMax)}</text>
      <text x={pad.l - 10} y={Y(yMin) + 4} textAnchor="end" fontFamily={theme.mono} fontSize={12} fill={theme.inkDim}>{Math.round(yMin)}</text>
      <text x={pad.l + iw / 2} y={height - 8} textAnchor="middle" fontFamily={theme.mono} fontSize={13} fill={theme.inkDim}>iteration →</text>
    </svg>
  );
};
