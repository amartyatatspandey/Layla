import React from "react";
import { AbsoluteFill, Sequence, OffthreadVideo, staticFile } from "remotion";
import { Background } from "../components/Background";
import { Kicker, Chip } from "../components/atoms";
import { theme } from "../theme";
import { BENCH } from "../data";

const APP_SECONDS = 15.5; // source clip length
const APP_SLOT = 240;     // frames (8s) — bench appears ~75s to match VO

const RealApp: React.FC = () => {
  const w = 1516, h = 853;
  return (
    <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
      <div style={{ position: "absolute", top: 28, left: 96 }}><Kicker>live proof · electron app</Kicker></div>
      <div style={{ position: "relative", width: w, height: h, transform: "translateY(-42px)" }}>
        <div style={{ position: "absolute", inset: 0, overflow: "hidden", border: `1px solid ${theme.panelStroke}` }}>
          <OffthreadVideo src={staticFile("footage/app.mp4")} playbackRate={APP_SECONDS / (APP_SLOT / 30)} style={{ width: "100%", height: "100%", objectFit: "cover", filter: "saturate(0.5) contrast(1.02)" }} />
        </div>
        {[[0, 0, 1, 1], [w, 0, -1, 1], [0, h, 1, -1], [w, h, -1, -1]].map(([cx, cy, sx, sy], i) => (
          <svg key={i} width={20} height={20} style={{ position: "absolute", left: cx - (sx < 0 ? 20 : 0), top: cy - (sy < 0 ? 20 : 0), overflow: "visible" }}>
            <path d={`M ${sx < 0 ? 20 : 0} ${(sy < 0 ? 20 : 0) + sy * 16} L ${sx < 0 ? 20 : 0} ${sy < 0 ? 20 : 0} L ${(sx < 0 ? 20 : 0) + sx * 16} ${sy < 0 ? 20 : 0}`} fill="none" stroke={theme.inkDim} strokeWidth={2} />
          </svg>
        ))}
        <div style={{ position: "absolute", top: -2, right: 14, transform: "translateY(-100%)", fontFamily: theme.mono, fontSize: 14, color: theme.accent, letterSpacing: 1 }}>● REC · autopilot-driven run + tab tour</div>
      </div>
    </AbsoluteFill>
  );
};

const Bench: React.FC = () => {
  return (
    <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
      <div style={{ width: 1560 }}>
        <Kicker>cli · layla bench</Kicker>
        <div style={{ fontFamily: theme.sans, fontSize: 34, fontWeight: 600, color: theme.ink, margin: "8px 0 6px" }}>
          Coupled-oscillator substrate <span style={{ color: theme.accent }}>vs</span> simulated annealing — lower is better.
        </div>
        <div style={{ fontFamily: theme.mono, fontSize: 14, color: theme.inkFaint, marginBottom: 20 }}>each bar normalized to that board's annealing baseline</div>
        {BENCH.map((b, i) => {
          const oscPct = (b.osc / b.anneal) * 100;
          return (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 24, marginBottom: 18 }}>
              <div style={{ width: 230, fontFamily: theme.mono, fontSize: 21, color: b.board === "mainboard" ? theme.accent : theme.ink }}>{b.board}</div>
              <div style={{ flex: 1, position: "relative", height: 48 }}>
                <div style={{ position: "absolute", top: 0, height: 20, width: "100%", background: theme.inkFaint }} />
                <div style={{ position: "absolute", top: 1, left: 10, fontFamily: theme.mono, fontSize: 14, color: theme.bg }}>anneal {b.anneal.toFixed(0)}</div>
                <div style={{ position: "absolute", top: 26, height: 20, width: `${oscPct}%`, background: theme.accent }} />
                <div style={{ position: "absolute", top: 27, left: 10, fontFamily: theme.mono, fontSize: 14, color: theme.bg }}>oscillator {b.osc.toFixed(0)}</div>
              </div>
              <Chip color={theme.accent}>{b.delta}%</Chip>
              <Chip color={theme.inkDim}>{b.substrate}</Chip>
            </div>
          );
        })}
        <div style={{ marginTop: 12, fontFamily: theme.sans, fontSize: 23, color: theme.inkDim }}>
          transfer: the substrate evolved on <span style={{ color: theme.ink }}>buck_imu</span> makes the optimizer
          <span style={{ color: theme.accent }}> ~24% better</span> on a new motor-driver board — zero new feedback.
        </div>
      </div>
    </AbsoluteFill>
  );
};

export const DemoProof: React.FC = () => (
  <AbsoluteFill style={{ backgroundColor: theme.bg }}>
    <Background />
    <Sequence durationInFrames={APP_SLOT}><RealApp /></Sequence>
    <Sequence from={APP_SLOT}><Bench /></Sequence>
  </AbsoluteFill>
);
