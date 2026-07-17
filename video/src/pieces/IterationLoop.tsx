import React from "react";
import { AbsoluteFill } from "remotion";
import { Background } from "../components/Background";
import { Kicker } from "../components/atoms";
import { theme, W, H } from "../theme";

const CX = 960, CY = 524, RX = 660, RY = 312;
const NODES = [
  { t: "SCHEMATIC", s: ".kicad_sch · netlist", acc: false },
  { t: "PLACEMENT", s: "coupled-oscillator substrate", acc: false },
  { t: "ROUTING", s: "critical nets · copper", acc: false },
  { t: "VALIDATION", s: "DRC · ratsnest · field-risk · EMI", acc: false },
  { t: "FEEDBACK", s: "engineer intent + hotspots", acc: false },
  { t: "SUBSTRATE Δ", s: "promote rule / mutate optimizer", acc: true },
];
const N = NODES.length;
const ang = (i: number) => (-90 + (i * 360) / N) * (Math.PI / 180);
const pos = (a: number) => ({ x: CX + RX * Math.cos(a), y: CY + RY * Math.sin(a) });

export const IterationLoop: React.FC = () => {
  return (
    <AbsoluteFill style={{ backgroundColor: theme.bg }}>
      <Background />
      <div style={{ position: "absolute", top: 70, left: 96 }}>
        <Kicker>the loop, made executable</Kicker>
        <div style={{ fontFamily: theme.sans, fontSize: 40, fontWeight: 600, color: theme.ink, marginTop: 10 }}>
          PCB layout already has a feedback loop.
        </div>
      </div>

      <svg width={W} height={H} style={{ position: "absolute" }}>
        <defs>
          <marker id="arrow" markerWidth="10" markerHeight="10" refX="6" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 Z" fill={theme.inkDim} /></marker>
        </defs>
        <ellipse cx={CX} cy={CY} rx={RX} ry={RY} fill="none" stroke={theme.panelStroke} strokeWidth={2} />
        {NODES.map((_, i) => {
          const a = ang(i) + Math.PI / N;
          const p = pos(a);
          const tang = a + Math.PI / 2;
          return <path key={i} d={`M ${p.x - 9 * Math.cos(tang)} ${p.y - 9 * Math.sin(tang)} L ${p.x + 9 * Math.cos(tang)} ${p.y + 9 * Math.sin(tang)}`} stroke={theme.inkFaint} strokeWidth={2} markerEnd="url(#arrow)" />;
        })}
        <text x={CX + 360} y={158} textAnchor="middle" fontFamily={theme.mono} fontSize={16} letterSpacing={3} fill={theme.accent}>
          ↺ NEXT BOARD STARTS SMARTER
        </text>
      </svg>

      {NODES.map((n, i) => {
        const p = pos(ang(i));
        const col = n.acc ? theme.accent : theme.ink;
        const bw = 300, bh = 74;
        return (
          <div key={i} style={{ position: "absolute", left: p.x - bw / 2, top: p.y - bh / 2, width: bw, height: bh }}>
            <div style={{ position: "absolute", inset: 0, background: theme.bg, border: `1.5px solid ${n.acc ? theme.accent : theme.panelStroke}` }} />
            <div style={{ position: "relative", padding: "13px 16px" }}>
              <div style={{ fontFamily: theme.mono, fontSize: 22, fontWeight: 700, letterSpacing: 2, color: col }}>{n.t}</div>
              <div style={{ fontFamily: theme.mono, fontSize: 14, color: theme.inkDim, marginTop: 3 }}>{n.s}</div>
            </div>
          </div>
        );
      })}

      <div style={{ position: "absolute", left: CX, top: CY, transform: "translate(-50%,-50%)", textAlign: "center", width: 520 }}>
        <div style={{ fontFamily: theme.sans, fontSize: 26, color: theme.inkDim, lineHeight: 1.4 }}>
          layla makes that loop <span style={{ color: theme.accent }}>executable</span> — every failure becomes
          <span style={{ color: theme.ink }}> pressure on the next attempt.</span>
        </div>
      </div>
    </AbsoluteFill>
  );
};
