import { contextBridge, ipcRenderer } from "electron";
import type { ElectronRpcTransport } from "../ipc/transport/ElectronRpcTransport";
import { rpcRequestChannel, rpcResponseChannel } from "../ipc/transport/ElectronRpcChannels";

const rpc: ElectronRpcTransport = Object.freeze({
  send(message: Parameters<ElectronRpcTransport["send"]>[0]) {
    ipcRenderer.send(rpcRequestChannel, message);
  },
  subscribe(listener: Parameters<ElectronRpcTransport["subscribe"]>[0]) {
    const handler = (_event: Electron.IpcRendererEvent, input: unknown) => {
      listener(input);
    };
    ipcRenderer.on(rpcResponseChannel, handler);
    return () => ipcRenderer.removeListener(rpcResponseChannel, handler);
  },
});

contextBridge.exposeInMainWorld("cake", Object.freeze({ rpc }));
