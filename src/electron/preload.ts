// Preload — exposes a minimal, safe API to the renderer.
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("layla", {
  listExamples: () => ipcRenderer.invoke("examples:list"),
  openSchematic: () => ipcRenderer.invoke("schematic:open"),
  run: (opts: any) => ipcRenderer.invoke("synth:run", opts),
  saveBoard: () => ipcRenderer.invoke("board:save"),
  saveRules: () => ipcRenderer.invoke("rules:save"),
  onFrame: (cb: (frame: any) => void) => {
    const handler = (_e: any, frame: any) => cb(frame);
    ipcRenderer.on("synth:frame", handler);
    return () => ipcRenderer.removeListener("synth:frame", handler);
  },
});
