import { contextBridge, ipcRenderer } from "electron";
import {
  desktopEventSchema,
  desktopRequestSchema,
  desktopResponseSchema,
  type CakeDesktopBridge
} from "../ipc/desktop-ipc";

const bridge: CakeDesktopBridge = {
  async request(input) {
    const request = desktopRequestSchema.parse(input);
    return desktopResponseSchema.parse(await ipcRenderer.invoke("cake:request", request));
  },
  subscribe(listener) {
    const handler = (_event: Electron.IpcRendererEvent, input: unknown) => {
      const result = desktopEventSchema.safeParse(input);
      if (result.success) listener(result.data);
    };
    ipcRenderer.on("cake:event", handler);
    return () => ipcRenderer.removeListener("cake:event", handler);
  }
};

contextBridge.exposeInMainWorld("cake", Object.freeze(bridge));
