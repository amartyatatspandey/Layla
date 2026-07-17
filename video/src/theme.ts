// Monochrome / brutalist palette. Grayscale base + ONE restrained accent (amber).
// No glows, no neon. Terse, high-contrast, instrument-like.
export const theme = {
  bg: "#0a0a0b",
  bgPanel: "#0f0f11",
  panelStroke: "#2a2a2e",
  ink: "#ececed",
  inkDim: "#8a8a90",
  inkFaint: "#46464c",
  // "cyan" name kept for compatibility -> neutral light steel (NOT glowing blue)
  cyan: "#c8c8cc",
  accent: "#c89a3c",   // the single accent, used sparingly
  green: "#c89a3c",    // positive emphasis -> accent
  red: "#c2655f",      // muted, errors / source
  orange: "#8f8f96",   // neutral (repulsion shown via dash, not hue)
  copper: "#9c9ca0",
  traceTop: "#c2c2c6",
  traceBot: "#56565c",
  grid: "#16161a",
  gridFaint: "#101012",
  mono: "ui-monospace, 'SF Mono', 'JetBrains Mono', Menlo, Consolas, monospace",
  sans: "Inter, system-ui, -apple-system, 'Segoe UI', sans-serif",
};

export const FPS = 30;
export const W = 1920;
export const H = 1080;

// global frame offsets for each piece (in frames @30fps)
export const SEQ = {
  hook: { from: 0, dur: 8 * FPS },
  loop: { from: 8 * FPS, dur: 12 * FPS },
  layers: { from: 20 * FPS, dur: 14 * FPS },
  osc: { from: 34 * FPS, dur: 20 * FPS },
  emi: { from: 54 * FPS, dur: 13 * FPS },
  demo: { from: 67 * FPS, dur: 15 * FPS },
  close: { from: 82 * FPS, dur: 8 * FPS },
};
export const TOTAL = 90 * FPS;
