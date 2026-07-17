import React from "react";
import { AbsoluteFill } from "remotion";
import { Background } from "../components/Background";
import { BoardSVG } from "../components/BoardSVG";
import { theme } from "../theme";

export const Close: React.FC = () => {
  return (
    <AbsoluteFill style={{ backgroundColor: theme.bg }}>
      <Background />
      <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
        <BoardSVG name="mainboard" layer="board" width={1280} height={840} opacity={0.28} style={{ position: "absolute" }} />
        <AbsoluteFill style={{ background: "radial-gradient(ellipse at center, rgba(10,10,11,0.82) 0%, rgba(10,10,11,0.96) 65%)" }} />
        <div style={{ textAlign: "center", maxWidth: 1400, position: "relative", zIndex: 2 }}>
          <div style={{ fontFamily: theme.mono, fontSize: 80, fontWeight: 700, color: theme.ink }}>
            field<span style={{ color: theme.accent }}>ratchet</span>
          </div>
          <div style={{ marginTop: 20, fontFamily: theme.sans, fontSize: 30, color: theme.ink, lineHeight: 1.4 }}>
            A self-improving PCB layout compiler: <span style={{ color: theme.accent }}>schematic in, routed board out</span> —
            <br /> every iteration makes the physical-design substrate sharper.
          </div>
          <div style={{ marginTop: 30, fontFamily: theme.sans, fontSize: 22, color: theme.inkDim, maxWidth: 1180, marginLeft: "auto", marginRight: "auto", lineHeight: 1.5 }}>
            Not an LLM drawing PCB art — netlists compile into oscillator dynamics, oscillator
            dynamics propose placements, and a separate field solver validates the result.
          </div>
        </div>
        <div style={{ position: "absolute", bottom: 188, zIndex: 2, display: "flex", alignItems: "center", gap: 14 }}>
          <div style={{ width: 8, height: 8, background: theme.accent }} />
          <div style={{ fontFamily: theme.mono, fontSize: 28, color: theme.ink, letterSpacing: 1 }}>github.com/amartyabro/layla</div>
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
