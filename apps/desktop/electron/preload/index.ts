import { contextBridge, ipcRenderer } from "electron";
import {
  desktopEventSchema,
  desktopRequestSchema,
  desktopResponseSchema,
  type CakeDesktopApi
} from "@cake/protocol";

const api: CakeDesktopApi = {
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

contextBridge.exposeInMainWorld("cake", Object.freeze(api));
