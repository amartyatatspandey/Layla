import React from "react";
import { useCurrentFrame } from "remotion";
import { theme, FPS } from "../theme";

// Narration shown as TWO stacked lines per block, each block held ~2x as long as
// a single line would be. start/end in SECONDS so a VO can be dropped in against
// the same marks. No motion (the two lines simply appear/leave on hard marks).
export type Block = { start: number; end: number; a: string; b?: string };

export const BLOCKS: Block[] = [
  // hook 0-8
  { start: 0.4, end: 8.0, a: "PCB layout is not a drawing problem.", b: "It is an iterative physical-design problem: place, route, violate, inspect, learn, repeat." },
  // loop 8-20
  { start: 8.3, end: 14.0, a: "layla turns that loop into software.", b: "It takes a KiCad schematic, builds a first-pass PCB, and routes the critical nets." },
  { start: 14.0, end: 20.0, a: "It scores DRC-style geometry and field risk,", b: "then feeds the failure modes back into the next iteration." },
  // layers 20-34
  { start: 20.3, end: 27.0, a: "The board is read as stacked physical layers —", b: "footprints, ratsnest, copper, courtyards, silkscreen, routing constraints." },
  { start: 27.0, end: 34.0, a: "Then thermal hotspots,", b: "and a progressive EMI validation pass." },
  // oscillator 34-54
  { start: 34.3, end: 41.0, a: "The core optimizer is a coupled phase-oscillator substrate.", b: "Shared nets become attractive couplings — they synchronize and place together." },
  { start: 41.0, end: 48.0, a: "Noisy-to-sensitive pairs become repulsive couplings that push apart.", b: "The synchronized phase field decodes into board placement." },
  { start: 48.0, end: 54.0, a: "The RSI loop mutates the substrate itself —", b: "and keeps only the changes that improve the canonical score." },
  // emi 54-67
  { start: 54.3, end: 61.0, a: "A separate damped-wave voxel pass checks the field response.", b: "It refines from millimeters down to ten microns inside the hottest regions." },
  { start: 61.0, end: 67.0, a: "It is not certified EMC —", b: "it is a fast validator that catches whether the optimizer makes field risk worse." },
  // demo 67-82
  { start: 67.3, end: 75.0, a: "In the app, each iteration explores new phase seeds,", b: "promotes better substrate mutations, and keeps the best layout — the curve only ratchets down." },
  { start: 75.0, end: 82.0, a: "In the CLI benchmark, the oscillator beats annealing on every board.", b: "And the evolved substrate transfers to a new board — with zero new feedback." },
  // close 82-90
  { start: 82.3, end: 90.0, a: "layla is a self-improving PCB layout compiler: schematic in, routed board out.", b: "Every iteration makes the physical-design substrate sharper." },
];

export const Subtitles: React.FC = () => {
  const t = useCurrentFrame() / FPS;
  const blk = BLOCKS.find((c) => t >= c.start && t < c.end);
  if (!blk) return null;
  return (
    <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 168, display: "flex", alignItems: "flex-end", justifyContent: "center", pointerEvents: "none" }}>
      <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 168, background: "linear-gradient(180deg, rgba(10,10,11,0) 0%, rgba(10,10,11,0.9) 70%)" }} />
      <div style={{ position: "relative", marginBottom: 30, maxWidth: 1560, textAlign: "center" }}>
        <div style={{ display: "inline-block", padding: "14px 28px", background: "rgba(10,10,11,0.78)", border: `1px solid ${theme.panelStroke}` }}>
          <div style={{ display: "flex", alignItems: "stretch", gap: 16 }}>
            <div style={{ width: 2, background: theme.accent }} />
            <div style={{ textAlign: "left" }}>
              <div style={{ fontFamily: theme.sans, fontSize: 33, fontWeight: 600, color: theme.ink, lineHeight: 1.32 }}>{blk.a}</div>
              {blk.b && <div style={{ fontFamily: theme.sans, fontSize: 30, fontWeight: 400, color: theme.inkDim, lineHeight: 1.32, marginTop: 6 }}>{blk.b}</div>}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
