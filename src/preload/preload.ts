import { contextBridge, ipcRenderer } from "electron";
import {
  desktopEventSchema,
  desktopRequestSchema,
  desktopResponseSchema,
  type CakeDesktopBridge,
} from "../ipc/desktop-ipc";
import { rpcRequestChannel, rpcResponseChannel } from "../ipc/transport/ElectronRpcChannels";

const rpc: CakeDesktopBridge["rpc"] = Object.freeze({
  send(message: Parameters<CakeDesktopBridge["rpc"]["send"]>[0]) {
    ipcRenderer.send(rpcRequestChannel, message);
  },
  subscribe(listener: Parameters<CakeDesktopBridge["rpc"]["subscribe"]>[0]) {
    const handler = (_event: Electron.IpcRendererEvent, input: unknown) => {
      listener(input);
    };
    ipcRenderer.on(rpcResponseChannel, handler);
    return () => ipcRenderer.removeListener(rpcResponseChannel, handler);
  },
});

const bridge: CakeDesktopBridge = {
  rpc,
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
  },
};

contextBridge.exposeInMainWorld("cake", Object.freeze(bridge));
