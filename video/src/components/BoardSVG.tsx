import React from "react";
import { Img, staticFile } from "remotion";

// Renders one of the engine-produced layer SVGs, scaled to fit a box while
// preserving aspect. All board.* layers share a viewBox so they overlay exactly.
export const BoardSVG: React.FC<{
  name: string; layer: string; width: number; height: number;
  opacity?: number; style?: React.CSSProperties;
}> = ({ name, layer, width, height, opacity = 1, style }) => (
  <Img
    src={staticFile(`svg/${name}.${layer}.svg`)}
    style={{ width, height, objectFit: "contain", opacity, ...style }}
  />
);
