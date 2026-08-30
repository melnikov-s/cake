import { describe, expect, it } from "vitest";
import {
  parseMainRpcMessage,
  parseRendererRpcMessage,
} from "../../../src/ipc/transport/ElectronRpcTransport";

describe("Electron Effect RPC transport envelopes", () => {
  it("decodes client and server messages with shared Effect Schemas", () => {
    expect(
      parseRendererRpcMessage({
        _tag: "Request",
        id: 1,
        tag: "application.getHomeDirectory",
        payload: undefined,
        headers: [],
      }),
    ).toMatchObject({ _tag: "Request", id: 1, tag: "application.getHomeDirectory" });
    expect(
      parseMainRpcMessage({
        _tag: "Exit",
        requestId: 1,
        exit: { _tag: "Success", value: "/home/user" },
      }),
    ).toMatchObject({ _tag: "Exit", requestId: 1 });
  });

  it("rejects malformed transport messages before RPC dispatch", () => {
    expect(() =>
      parseRendererRpcMessage({
        _tag: "Request",
        id: 1,
        tag: "application.getHomeDirectory",
        payload: undefined,
        headers: "untrusted",
      }),
    ).toThrow();
    expect(() => parseMainRpcMessage({ _tag: "Chunk", requestId: 1, values: [] })).toThrow();
  });
});
