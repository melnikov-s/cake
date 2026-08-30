import { Result } from "effect";
import { describe, expect, it } from "vitest";
import {
  parseMainRpcMessage,
  parseRendererRpcMessage,
} from "../../../src/ipc/transport/ElectronRpcTransport";

describe("Electron Effect RPC transport envelopes", () => {
  it("decodes client and server messages with shared Effect Schemas", () => {
    const rendererMessage = parseRendererRpcMessage({
      _tag: "Request",
      id: 1,
      tag: "application.getHomeDirectory",
      payload: undefined,
      headers: [],
    });
    expect(Result.isSuccess(rendererMessage)).toBe(true);
    if (Result.isSuccess(rendererMessage))
      expect(rendererMessage.success).toMatchObject({
        _tag: "Request",
        id: 1,
        tag: "application.getHomeDirectory",
      });

    const mainMessage = parseMainRpcMessage({
      _tag: "Exit",
      requestId: 1,
      exit: { _tag: "Success", value: "/home/user" },
    });
    expect(Result.isSuccess(mainMessage)).toBe(true);
    if (Result.isSuccess(mainMessage))
      expect(mainMessage.success).toMatchObject({ _tag: "Exit", requestId: 1 });
  });

  it("rejects malformed transport messages before RPC dispatch", () => {
    expect(
      Result.isFailure(
        parseRendererRpcMessage({
          _tag: "Request",
          id: 1,
          tag: "application.getHomeDirectory",
          payload: undefined,
          headers: "untrusted",
        }),
      ),
    ).toBe(true);
    expect(Result.isFailure(parseMainRpcMessage({ _tag: "Chunk", requestId: 1, values: [] }))).toBe(
      true,
    );
  });
});
