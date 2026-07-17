import React from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { Background } from "../components/Background";
import { BoardSVG } from "../components/BoardSVG";
import { VoxelField } from "../components/VoxelField";
import { Kicker, Panel } from "../components/atoms";
import { theme } from "../theme";
import { MAIN } from "../data";

const NAME = "mainboard";
const BOX = { x: 96, y: 150, w: 1092, h: 752 };

type State = { key: string; label: string; sub: string; render: () => React.ReactNode };
const STATES: State[] = [
  { key: "footprints", label: "FOOTPRINTS + PADS", sub: "187 placed components", render: () => <BoardSVG name={NAME} layer="pads" width={BOX.w} height={BOX.h} style={{ position: "absolute" }} /> },
  { key: "ratsnest", label: "RATSNEST / NETS", sub: "450 nets · logical connectivity", render: () => <BoardSVG name={NAME} layer="rats" width={BOX.w} height={BOX.h} style={{ position: "absolute" }} /> },
  { key: "copper", label: "COPPER · F.Cu / B.Cu", sub: "fine routed traces", render: () => <BoardSVG name={NAME} layer="routes" width={BOX.w} height={BOX.h} style={{ position: "absolute" }} /> },
  { key: "courtyard", label: "COURTYARDS · HOTSPOTS", sub: "clearance + risk heatmap", render: () => <BoardSVG name={NAME} layer="heatmap" width={BOX.w} height={BOX.h} style={{ position: "absolute" }} /> },
  { key: "emi", label: "EMI FIELD RESPONSE", sub: "damped-wave voxel pass", render: () => <div style={{ position: "relative", width: BOX.w, height: BOX.h }}><VoxelField level={MAIN.emi.levels[1]} boardW={MAIN.board.width} boardH={MAIN.board.height} width={BOX.w} height={BOX.h} gamma={0.7} /></div> },
  { key: "final", label: "ROUTED BOARD", sub: "all layers composited", render: () => <BoardSVG name={NAME} layer="board" width={BOX.w} height={BOX.h} style={{ position: "absolute" }} /> },
];

const DUR = 68;
const LOUPE = { w: 286, h: 286, z: 3.6, fx: 0.46, fy: 0.66, right: 18, bottom: 64 };

const Loupe: React.FC<{ layer: string }> = ({ layer }) => {
  const { w: LW, h: LH, z: Z, fx, fy } = LOUPE;
  return (
    <div style={{ position: "absolute", right: LOUPE.right, bottom: LOUPE.bottom, width: LW, height: LH }}>
      <div style={{ position: "absolute", inset: 0, overflow: "hidden", border: `1.5px solid ${theme.accent}`, background: "#0c0c0e" }}>
        <BoardSVG name={NAME} layer={layer} width={BOX.w * Z} height={BOX.h * Z} style={{ position: "absolute", left: -(fx * BOX.w * Z - LW / 2), top: -(fy * BOX.h * Z - LH / 2) }} />
      </div>
      <div style={{ position: "absolute", top: -22, left: 2, fontFamily: theme.mono, fontSize: 13, letterSpacing: 2, color: theme.accent }}>×3.6 DETAIL · 0.18mm traces</div>
    </div>
  );
};

export const LayerMontage: React.FC = () => {
  const f = useCurrentFrame();
  const idx = Math.min(STATES.length - 1, Math.floor(f / DUR));
  const cur = STATES[idx];
  const showLoupe = cur.key === "copper" || cur.key === "final";
  const sx = BOX.x + 0.6 * BOX.w, sy = BOX.y + 0.42 * BOX.h;
  const lx = BOX.x + BOX.w - LOUPE.right - LOUPE.w, ly = BOX.y + BOX.h - LOUPE.bottom - LOUPE.h;

  return (
    <AbsoluteFill style={{ backgroundColor: theme.bg }}>
      <Background />
      <div style={{ position: "absolute", top: 56, left: 96 }}>
        <Kicker>layered physical evidence</Kicker>
        <div style={{ fontFamily: theme.sans, fontSize: 36, fontWeight: 600, color: theme.ink, marginTop: 8 }}>
          The board is read as <span style={{ color: theme.accent }}>stacked physical layers</span>, not a flat image.
        </div>
      </div>

      <Panel x={BOX.x} y={BOX.y} w={BOX.w} h={BOX.h} label={`layer ${idx + 1} / ${STATES.length}`}>
        <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>{cur.render()}</AbsoluteFill>
        <div style={{ position: "absolute", bottom: 16, left: 22 }}>
          <div style={{ fontFamily: theme.mono, fontSize: 25, letterSpacing: 3, color: theme.ink, fontWeight: 700 }}>{cur.label}</div>
          <div style={{ fontFamily: theme.mono, fontSize: 16, color: theme.inkDim, marginTop: 3 }}>{cur.sub}</div>
        </div>
        {showLoupe && <Loupe layer={cur.key === "final" ? "board" : "routes"} />}
      </Panel>

      {showLoupe && (
        <svg style={{ position: "absolute", left: 0, top: 0, pointerEvents: "none" }} width={1920} height={1080}>
          <rect x={sx - 52} y={sy - 52} width={104} height={104} fill="none" stroke={theme.accent} strokeWidth={1.5} />
          <line x1={sx + 52} y1={sy - 52} x2={lx} y2={ly} stroke={theme.accent} strokeWidth={1} strokeDasharray="4 4" opacity={0.5} />
          <line x1={sx + 52} y1={sy + 52} x2={lx} y2={ly + LOUPE.h} stroke={theme.accent} strokeWidth={1} strokeDasharray="4 4" opacity={0.5} />
        </svg>
      )}

      <div style={{ position: "absolute", left: BOX.x + BOX.w + 44, top: BOX.y + 30, width: 300 }}>
        <div style={{ fontFamily: theme.mono, fontSize: 14, letterSpacing: 3, color: theme.inkDim, marginBottom: 16 }}>LAYER STACK</div>
        {STATES.map((s, i) => {
          const active = i === idx, done = i < idx;
          return (
            <div key={s.key} style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 15, opacity: active ? 1 : done ? 0.55 : 0.3 }}>
              <div style={{ width: 12, height: 12, background: active ? theme.accent : done ? theme.inkFaint : "transparent", border: `1.5px solid ${active ? theme.accent : theme.panelStroke}` }} />
              <div style={{ fontFamily: theme.mono, fontSize: 17, color: active ? theme.ink : theme.inkDim, letterSpacing: 1 }}>{s.label}</div>
            </div>
          );
        })}
        <div style={{ marginTop: 24, fontFamily: theme.mono, fontSize: 13, color: theme.inkFaint, lineHeight: 1.6 }}>
          autonomy mainboard<br />187 components · 450 nets<br />1685 couplings · 132×100 mm
        </div>
      </div>
    </AbsoluteFill>
  );
};
