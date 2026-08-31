import { contextBridge, ipcRenderer } from "electron";
import type { CakeDesktopBridge } from "../ipc/desktop-ipc";
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

const bridge: CakeDesktopBridge = { rpc };

contextBridge.exposeInMainWorld("cake", Object.freeze(bridge));
