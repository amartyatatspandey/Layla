import React from "react";
import { AbsoluteFill } from "remotion";
import { theme, W, H } from "../theme";

// Static engineering graticule — no drift. Terse, flat, brutalist.
export const Background: React.FC<{ drift?: number; cell?: number }> = ({ cell = 48 }) => {
  return (
    <AbsoluteFill style={{ backgroundColor: theme.bg }}>
      <svg width={W} height={H} style={{ position: "absolute" }}>
        <defs>
          <pattern id="g-fine" width={cell} height={cell} patternUnits="userSpaceOnUse">
            <path d={`M ${cell} 0 L 0 0 0 ${cell}`} fill="none" stroke={theme.gridFaint} strokeWidth={1} />
          </pattern>
          <pattern id="g-coarse" width={cell * 4} height={cell * 4} patternUnits="userSpaceOnUse">
            <path d={`M ${cell * 4} 0 L 0 0 0 ${cell * 4}`} fill="none" stroke={theme.grid} strokeWidth={1} />
          </pattern>
        </defs>
        <rect width={W} height={H} fill="url(#g-fine)" />
        <rect width={W} height={H} fill="url(#g-coarse)" />
      </svg>
    </AbsoluteFill>
  );
};
