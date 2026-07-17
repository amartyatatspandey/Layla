import React from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { Background } from "../components/Background";
import { VoxelField } from "../components/VoxelField";
import { Kicker, Panel, Chip } from "../components/atoms";
import { theme } from "../theme";
import { MAIN } from "../data";

const SRC = MAIN;
const LV = SRC.emi.levels; // [4mm, 1mm, 250µm, 50µm, 10µm]
const STAGE = 78;
const BOX = { x: 96, y: 206, w: 1040, h: 660 };

const fmtCell = (mm: number) => mm >= 1 ? `${mm} mm` : `${Math.round(mm * 1000)} µm`;
const LABELS = ["full board", "full board", "zoom · hotspot", "zoom · hotspot", "hotspot core"];

export const EmiVoxels: React.FC = () => {
  const f = useCurrentFrame();
  const stage = Math.min(LV.length - 1, Math.floor(f / STAGE));
  const lv = LV[stage];
  const bW = SRC.emi.board?.width ?? SRC.board.width;
  const bH = SRC.emi.board?.height ?? SRC.board.height;
  const hs = SRC.emi.hotspot ?? { x: bW / 2, y: bH / 2 };

  // stylized nested-squares zoom indicator (not to scale — each step nests inward)
  const sd = { w: 300, h: 220 };

  return (
    <AbsoluteFill style={{ backgroundColor: theme.bg }}>
      <Background />
      <div style={{ position: "absolute", top: 64, left: 96 }}>
        <Kicker color={theme.accent}>independent field validation · multi-scale</Kicker>
        <div style={{ fontFamily: theme.sans, fontSize: 36, fontWeight: 600, color: theme.ink, marginTop: 8 }}>
          A damped-wave voxel pass — from millimeters down to <span style={{ color: theme.accent }}>10 microns</span>.
        </div>
      </div>

      <Panel x={BOX.x} y={BOX.y} w={BOX.w} h={BOX.h} label={`voxel grid · ${lv.w} × ${lv.h} cells`}>
        <VoxelField level={lv} boardW={lv.win ? lv.win.w : bW} boardH={lv.win ? lv.win.h : bH} width={BOX.w} height={BOX.h} gamma={0.6} />
        <div style={{ position: "absolute", left: 22, bottom: 18 }}>
          <div style={{ fontFamily: theme.mono, fontSize: 44, fontWeight: 700, color: theme.accent }}>{fmtCell(lv.cellMm)}</div>
          <div style={{ fontFamily: theme.mono, fontSize: 16, color: theme.inkDim }}>{LABELS[stage]} · peak {lv.peak.toFixed(2)}</div>
        </div>
        {lv.win && (
          <div style={{ position: "absolute", right: 20, top: 16, textAlign: "right", fontFamily: theme.mono, fontSize: 15, color: theme.inkDim }}>
            window {lv.win.w}×{lv.win.h} mm @ ({lv.win.x.toFixed(1)}, {lv.win.y.toFixed(1)})
          </div>
        )}
      </Panel>

      {/* right column */}
      <div style={{ position: "absolute", left: BOX.x + BOX.w + 60, top: BOX.y - 2, width: 560 }}>
        <div style={{ fontFamily: theme.mono, fontSize: 14, letterSpacing: 3, color: theme.inkDim }}>SOLVER</div>
        <div style={{ fontFamily: theme.mono, fontSize: 19, color: theme.ink, marginTop: 6 }}>progressive_damped_wave_2p5d</div>

        <div style={{ marginTop: 26, fontFamily: theme.mono, fontSize: 14, letterSpacing: 3, color: theme.inkDim }}>DESCENT</div>
        <div style={{ marginTop: 12 }}>
          {LV.map((l, i) => {
            const on = i <= stage, act = i === stage;
            return (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 10, opacity: on ? 1 : 0.3 }}>
                <div style={{ width: 13, height: 13, background: act ? theme.accent : on ? theme.inkFaint : "transparent", border: `1.5px solid ${on ? theme.accent : theme.panelStroke}` }} />
                <div style={{ fontFamily: theme.mono, fontSize: 21, color: act ? theme.ink : theme.inkDim, width: 110 }}>{fmtCell(l.cellMm)}</div>
                <div style={{ fontFamily: theme.mono, fontSize: 15, color: theme.inkFaint, width: 90 }}>{l.w}×{l.h}</div>
                <div style={{ fontFamily: theme.mono, fontSize: 15, color: theme.inkDim }}>{l.win ? "zoom" : "full board"}</div>
              </div>
            );
          })}
        </div>

        {/* nested scale indicator */}
        <div style={{ marginTop: 26, fontFamily: theme.mono, fontSize: 14, letterSpacing: 3, color: theme.inkDim }}>SCALE</div>
        <svg width={sd.w} height={sd.h} style={{ marginTop: 10, border: `1px solid ${theme.panelStroke}`, background: "#0c0c0e" }}>
          {LV.map((l, i) => {
            // nested squares, each ~64% of the previous, centered
            const frac = Math.pow(0.64, i);
            const w = (sd.w - 24) * frac, h = (sd.h - 24) * frac;
            const x = (sd.w - w) / 2, y = (sd.h - h) / 2;
            const act = i === stage, on = i <= stage;
            return (
              <g key={i}>
                <rect x={x} y={y} width={w} height={h} fill="none" stroke={act ? theme.accent : on ? theme.inkDim : theme.inkFaint} strokeWidth={act ? 2 : 1} opacity={on ? 1 : 0.4} />
                {act && <rect x={x} y={y} width={w} height={h} fill={theme.accent} opacity={0.06} />}
              </g>
            );
          })}
          <text x={sd.w / 2} y={sd.h / 2 + 4} textAnchor="middle" fontFamily={theme.mono} fontSize={13} fill={theme.accent}>{fmtCell(lv.cellMm)}</text>
        </svg>
        <div style={{ marginTop: 8, fontFamily: theme.mono, fontSize: 13, color: theme.inkFaint }}>hotspot @ ({hs.x.toFixed(0)}, {hs.y.toFixed(0)}) mm · victim {SRC.emi.sensitiveProbeMax || "—"}</div>
      </div>

      <div style={{ position: "absolute", left: 96, bottom: 178, fontFamily: theme.mono, fontSize: 18, color: theme.inkDim }}>
        not certified EMC — a fast, physics-inspired validator that catches whether the optimizer makes field risk <span style={{ color: theme.accent }}>worse</span>.
      </div>
    </AbsoluteFill>
  );
};
