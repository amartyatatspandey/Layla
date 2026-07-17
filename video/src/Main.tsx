import React from "react";
import { AbsoluteFill, Sequence } from "remotion";
import { SEQ, theme } from "./theme";
import { Hook } from "./pieces/Hook";
import { IterationLoop } from "./pieces/IterationLoop";
import { LayerMontage } from "./pieces/LayerMontage";
import { OscillatorCore } from "./pieces/OscillatorCore";
import { EmiVoxels } from "./pieces/EmiVoxels";
import { DemoProof } from "./pieces/DemoProof";
import { Close } from "./pieces/Close";
import { Subtitles } from "./components/Subtitles";

// Hard cuts between pieces — terse, no decorative crossfades.
const Piece: React.FC<{ from: number; dur: number; children: React.ReactNode }> = ({ from, dur, children }) => (
  <Sequence from={from} durationInFrames={dur}>{children}</Sequence>
);

export const Main: React.FC = () => (
  <AbsoluteFill style={{ backgroundColor: theme.bg }}>
    <Piece from={SEQ.hook.from} dur={SEQ.hook.dur}><Hook /></Piece>
    <Piece from={SEQ.loop.from} dur={SEQ.loop.dur}><IterationLoop /></Piece>
    <Piece from={SEQ.layers.from} dur={SEQ.layers.dur}><LayerMontage /></Piece>
    <Piece from={SEQ.osc.from} dur={SEQ.osc.dur}><OscillatorCore /></Piece>
    <Piece from={SEQ.emi.from} dur={SEQ.emi.dur}><EmiVoxels /></Piece>
    <Piece from={SEQ.demo.from} dur={SEQ.demo.dur}><DemoProof /></Piece>
    <Piece from={SEQ.close.from} dur={SEQ.close.dur}><Close /></Piece>
    <Subtitles />
  </AbsoluteFill>
);
