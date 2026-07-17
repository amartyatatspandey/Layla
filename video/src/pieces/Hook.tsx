import React from "react";
import { AbsoluteFill, Sequence, useCurrentFrame } from "remotion";
import { Background } from "../components/Background";
import { BoardSVG } from "../components/BoardSVG";
import { VoxelField } from "../components/VoxelField";
import { theme } from "../theme";
import { MAIN } from "../data";

const Shot: React.FC<{ children: React.ReactNode; label: string }> = ({ children, label }) => (
  <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
    {children}
    <div style={{ position: "absolute", bottom: 210, left: 96, fontFamily: theme.mono, fontSize: 22, letterSpacing: 8, textTransform: "uppercase", color: theme.inkDim }}>
      {label}
    </div>
  </AbsoluteFill>
);

export const Hook: React.FC = () => {
  const f = useCurrentFrame();
  const titleAt = 150;
  return (
    <AbsoluteFill style={{ backgroundColor: theme.bg }}>
      <Background />
      <Sequence durationInFrames={48}><Shot label="ratsnest"><BoardSVG name="mainboard" layer="rats" width={1280} height={820} /></Shot></Sequence>
      <Sequence from={48} durationInFrames={48}><Shot label="routed copper"><BoardSVG name="mainboard" layer="routes" width={1280} height={820} /></Shot></Sequence>
      <Sequence from={96} durationInFrames={54}><Shot label="field response">
        <div style={{ position: "relative", width: 1200, height: 800 }}>
          <VoxelField level={MAIN.emi.levels[1]} boardW={MAIN.board.width} boardH={MAIN.board.height} width={1200} height={800} gamma={0.48} />
        </div>
      </Shot></Sequence>

      {f >= titleAt && (
        <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
          <BoardSVG name="mainboard" layer="board" width={1440} height={920} opacity={0.14} style={{ position: "absolute" }} />
          <div style={{ textAlign: "center", position: "relative", zIndex: 2 }}>
            <div style={{ fontFamily: theme.mono, fontSize: 96, fontWeight: 700, letterSpacing: 2, color: theme.ink }}>
              field<span style={{ color: theme.accent }}>ratchet</span>
            </div>
            <div style={{ marginTop: 18, fontFamily: theme.sans, fontSize: 30, color: theme.inkDim, maxWidth: 1100, lineHeight: 1.35 }}>
              PCB layout is not a drawing problem. It is an iterative physical-design problem:
              <br /> place · route · violate · inspect · learn · repeat.
            </div>
          </div>
        </AbsoluteFill>
      )}
    </AbsoluteFill>
  );
};
