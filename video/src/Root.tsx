import React from "react";
import { Composition } from "remotion";
import { Main } from "./Main";
import { W, H, FPS, TOTAL } from "./theme";

export const RemotionRoot: React.FC = () => (
  <Composition id="Main" component={Main} durationInFrames={TOTAL} fps={FPS} width={W} height={H} />
);
