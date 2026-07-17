import React from "react";
import { AbsoluteFill } from "remotion";
import { Background } from "../components/Background";
import { Kicker } from "../components/atoms";
import { forceLayout, rc } from "../components/forceLayout";
import { theme, W, H } from "../theme";
import { MAIN } from "../data";

const SRC = MAIN;
const G = SRC.graph;
const PANEL = { y: 188, h: 580 };
const L = { x: 70, w: 556 };
const M = { x: 686, w: 548 };
const R = { x: 1294, w: 556 };

// sample the very dense repulsive couplings so the mesh reads as a network
const DRAW_EDGES = G.edges.filter((e, i) => e.kind === "net" || e.kind === "cluster" || i % 9 === 0);
// force layout computed ONCE at module load (not per frame) — big graphs are expensive
const LAY = forceLayout(G.nodes, G.edges, L.w, PANEL.h);

const edgeStyle = (kind: string) => {
  if (kind === "noisy_sensitive" || kind === "repel") return { c: theme.inkFaint, dash: "5 5", op: 0.28, rep: true };
  if (kind === "cluster") return { c: theme.inkFaint, dash: "", op: 0.35, rep: false };
  return { c: theme.inkDim, dash: "", op: 0.5, rep: false }; // net
};

const Header: React.FC<{ x: number; w: number; n: string; title: string }> = ({ x, w, n, title }) => (
  <div style={{ position: "absolute", left: x, top: PANEL.y - 42, width: w }}>
    <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
      <span style={{ fontFamily: theme.mono, fontSize: 20, color: theme.accent, fontWeight: 700 }}>{n}</span>
      <span style={{ fontFamily: theme.mono, fontSize: 18, color: theme.ink, letterSpacing: 2 }}>{title}</span>
    </div>
    <div style={{ height: 1, background: theme.panelStroke, marginTop: 8 }} />
  </div>
);

export const OscillatorCore: React.FC = () => {
  // phase wheels — final synchronized state (static)
  const wheelR = 116;
  const wx = { cx: M.x + M.w / 2, cy: PANEL.y + 158 };
  const wy = { cx: M.x + M.w / 2, cy: PANEL.y + 430 };
  const Rx = G.orderX[G.orderX.length - 1] ?? 0;
  const Rg = G.order[G.order.length - 1] ?? 0;
  const meanVec = (sel: (n: typeof G.nodes[number]) => number) => {
    let sx = 0, sy = 0;
    G.nodes.forEach((n) => { sx += Math.cos(sel(n)); sy += Math.sin(sel(n)); });
    return Math.atan2(sy, sx);
  };
  const meanX = meanVec((n) => n.thetaX), meanY = meanVec((n) => n.thetaY);

  // decoded placement (real final x,y)
  const bw = SRC.board.width, bh = SRC.board.height;
  const psc = Math.min((R.w - 60) / bw, (PANEL.h - 60) / bh);
  const pbw = bw * psc, pbh = bh * psc;
  const pox = R.x + (R.w - pbw) / 2, poy = PANEL.y + (PANEL.h - pbh) / 2;

  return (
    <AbsoluteFill style={{ backgroundColor: theme.bg }}>
      <Background />
      <div style={{ position: "absolute", top: 54, left: 96 }}>
        <Kicker>the intellectual core</Kicker>
        <div style={{ fontFamily: theme.sans, fontSize: 38, fontWeight: 600, color: theme.ink, marginTop: 6 }}>
          Placement is a <span style={{ color: theme.accent }}>coupled phase-oscillator</span> substrate.
        </div>
      </div>

      <Header x={L.x} w={L.w} n="01" title="NETLIST → COUPLINGS" />
      <Header x={M.x} w={M.w} n="02" title="PHASES SYNCHRONIZE" />
      <Header x={R.x} w={R.w} n="03" title="DECODE → PLACEMENT" />

      <svg width={W} height={H} style={{ position: "absolute" }}>
        {/* LEFT: netlist graph + couplings (static) */}
        <g transform={`translate(${L.x},${PANEL.y})`}>
          <rect x={0} y={0} width={L.w} height={PANEL.h} fill="none" stroke={theme.panelStroke} strokeWidth={1} />
          {DRAW_EDGES.map((e, k) => {
            const a = LAY[e.i], b = LAY[e.j]; const st = edgeStyle(e.kind);
            return <line key={k} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={st.c} strokeWidth={st.rep ? 0.6 : 1} strokeDasharray={st.dash} opacity={st.op} />;
          })}
          {G.nodes.map((nd, i) => {
            const p = LAY[i];
            const big = nd.role === "mcu" || nd.role === "motor_driver" || nd.role === "regulator" || nd.role === "rf";
            const ro = big ? 7 : 4;
            return (
              <g key={i}>
                <circle cx={p.x} cy={p.y} r={ro} fill={theme.bg} stroke={rc(nd.role)} strokeWidth={1.3} />
                <circle cx={p.x} cy={p.y} r={ro * 0.4} fill={rc(nd.role)} />
              </g>
            );
          })}
        </g>

        {/* MIDDLE: two phase wheels θx, θy (static synchronized state) */}
        {[{ w: wx, ang: (n: any) => n.thetaX, mean: meanX, R: Rx, lab: "θx · x-placement phase" },
          { w: wy, ang: (n: any) => n.thetaY, mean: meanY, R: Rg, lab: "θy · y-placement phase" }].map((W2, wi) => (
          <g key={wi}>
            <circle cx={W2.w.cx} cy={W2.w.cy} r={wheelR} fill="#0c0c0e" stroke={theme.panelStroke} strokeWidth={1.5} />
            <circle cx={W2.w.cx} cy={W2.w.cy} r={wheelR} fill="none" stroke={theme.gridFaint} strokeWidth={1} strokeDasharray="2 6" />
            {G.nodes.map((nd, i) => {
              const t = W2.ang(nd);
              const x = W2.w.cx + Math.cos(t) * wheelR, y = W2.w.cy + Math.sin(t) * wheelR;
              return <circle key={i} cx={x} cy={y} r={3.5} fill={rc(nd.role)} stroke={theme.bg} strokeWidth={0.8} opacity={0.9} />;
            })}
            <line x1={W2.w.cx} y1={W2.w.cy} x2={W2.w.cx + Math.cos(W2.mean) * wheelR * W2.R} y2={W2.w.cy + Math.sin(W2.mean) * wheelR * W2.R} stroke={theme.accent} strokeWidth={2.5} />
            <circle cx={W2.w.cx} cy={W2.w.cy} r={3} fill={theme.accent} />
            <text x={W2.w.cx} y={W2.w.cy + wheelR + 26} textAnchor="middle" fontFamily={theme.mono} fontSize={14} fill={theme.inkDim}>{W2.lab}</text>
            <text x={W2.w.cx + wheelR - 4} y={W2.w.cy - wheelR + 4} textAnchor="end" fontFamily={theme.mono} fontSize={13} fill={theme.accent}>R={W2.R.toFixed(2)}</text>
          </g>
        ))}

        {/* RIGHT: decoded placement (static, real coords) */}
        <g>
          <rect x={pox} y={poy} width={pbw} height={pbh} fill="#0c0c0e" stroke={theme.panelStroke} strokeWidth={1.5} />
          {G.edges.filter((e) => e.kind === "net").map((e, k) => {
            const a = G.nodes[e.i], b = G.nodes[e.j];
            return <line key={k} x1={pox + a.x * psc} y1={poy + a.y * psc} x2={pox + b.x * psc} y2={poy + b.y * psc} stroke={theme.inkDim} strokeWidth={0.5} opacity={0.12} />;
          })}
          {G.nodes.map((nd, i) => (
            <rect key={i} x={pox + nd.x * psc - 4} y={poy + nd.y * psc - 3} width={8} height={6} rx={1} fill={theme.bg} stroke={rc(nd.role)} strokeWidth={1} />
          ))}
          <text x={pox + pbw / 2} y={poy + pbh + 24} textAnchor="middle" fontFamily={theme.mono} fontSize={14} fill={theme.inkDim}>synchronized phase field → board coordinates</text>
        </g>
      </svg>

      {/* coupling legend */}
      <div style={{ position: "absolute", left: L.x + 8, top: PANEL.y + PANEL.h + 16, display: "flex", gap: 26 }}>
        {[["shared net → attract / sync", theme.inkDim, false], ["cluster → attract", theme.inkFaint, false], ["noisy ↔ sensitive → repel / anti-phase", theme.inkFaint, true]].map(([t, c, d], i) => (
          <div key={i} style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <svg width={30} height={6}><line x1={0} y1={3} x2={30} y2={3} stroke={c as string} strokeWidth={2} strokeDasharray={d ? "4 4" : ""} /></svg>
            <span style={{ fontFamily: theme.mono, fontSize: 14, color: theme.inkDim }}>{t as string}</span>
          </div>
        ))}
        <span style={{ fontFamily: theme.mono, fontSize: 14, color: theme.inkFaint }}>{G.nodes.length} nodes · {G.edges.length} couplings</span>
      </div>

      {/* formula + RSI line */}
      <div style={{ position: "absolute", left: 0, right: 0, bottom: 178, textAlign: "center" }}>
        <div style={{ fontFamily: theme.mono, fontSize: 25, color: theme.ink, letterSpacing: 1 }}>
          <span style={{ color: theme.inkDim }}>x, y =</span> board_size · sigmoid( a·sin θ + b·cos θ )
        </div>
        <div style={{ fontFamily: theme.sans, fontSize: 19, color: theme.inkDim, marginTop: 8 }}>
          the RSI loop mutates the <span style={{ color: theme.accent }}>substrate itself</span> — couplings · drives · damping · readout —
          and promotes a change only when the canonical score improves.
        </div>
      </div>
    </AbsoluteFill>
  );
};
