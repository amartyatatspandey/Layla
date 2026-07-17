import React from "react";
import { theme } from "../theme";

// ---- small-caps mono kicker label ----
export const Kicker: React.FC<{ children: React.ReactNode; color?: string; style?: React.CSSProperties }> = ({ children, color = theme.inkDim, style }) => (
  <div style={{ fontFamily: theme.mono, fontSize: 20, letterSpacing: 6, textTransform: "uppercase", color, ...style }}>{children}</div>
);

// ---- hairline panel frame with corner ticks (static) ----
export const Panel: React.FC<{ x: number; y: number; w: number; h: number; label?: string; appear?: number; children?: React.ReactNode }> = ({ x, y, w, h, label, children }) => {
  const t = 14;
  return (
    <div style={{ position: "absolute", left: x, top: y, width: w, height: h }}>
      <svg width={w} height={h} style={{ position: "absolute", overflow: "visible" }}>
        <rect x={0.5} y={0.5} width={w - 1} height={h - 1} fill="none" stroke={theme.panelStroke} strokeWidth={1} />
        {[[0, 0, 1, 1], [w, 0, -1, 1], [0, h, 1, -1], [w, h, -1, -1]].map(([cx, cy, sx, sy], i) => (
          <path key={i} d={`M ${cx} ${cy + sy * t} L ${cx} ${cy} L ${cx + sx * t} ${cy}`} fill="none" stroke={theme.inkDim} strokeWidth={1.5} />
        ))}
      </svg>
      {label && (
        <div style={{ position: "absolute", top: -11, left: 18, padding: "0 8px", background: theme.bg, fontFamily: theme.mono, fontSize: 13, letterSpacing: 3, textTransform: "uppercase", color: theme.inkDim }}>{label}</div>
      )}
      {children}
    </div>
  );
};

// ---- static lower-left caption (terse) ----
export const Caption: React.FC<{ at?: number; text: string; sub?: string; x?: number; y?: number }> = ({ text, sub, x = 96, y = 900 }) => (
  <div style={{ position: "absolute", left: x, top: y }}>
    <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
      <div style={{ width: 3, height: 30, background: theme.accent }} />
      <div style={{ fontFamily: theme.sans, fontSize: 34, fontWeight: 600, color: theme.ink }}>{text}</div>
    </div>
    {sub && <div style={{ marginLeft: 17, marginTop: 6, fontFamily: theme.mono, fontSize: 17, color: theme.inkDim }}>{sub}</div>}
  </div>
);

// monospace tag chip
export const Chip: React.FC<{ children: React.ReactNode; color?: string }> = ({ children, color = theme.inkDim }) => (
  <span style={{ fontFamily: theme.mono, fontSize: 14, letterSpacing: 1.5, color, border: `1px solid ${color}`, padding: "3px 9px" }}>{children}</span>
);
