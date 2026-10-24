// @vitest-environment jsdom
import type { FromClientEncoded, FromServerEncoded } from "effect/unstable/rpc/RpcMessage";
import { afterEach, expect, it, vi } from "vitest";
import { makeClient } from "../../../src/renderer/client/ClientLive";
import { makeRuntime } from "../../../src/renderer/runtime";

afterEach(() => {
  delete document.documentElement.dataset.theme;
  vi.unstubAllGlobals();
});

it.each(["light", "dark", "system"] as const)(
  "acquires and presents new/reopened native editors with Cake's effective %s theme",
  async (preference) => {
    document.documentElement.dataset.theme = preference;
    let systemDark = false;
    vi.stubGlobal("matchMedia", () => ({ matches: systemDark }));
    const messages: FromClientEncoded[] = [];
    const listeners = new Set<(message: unknown) => void>();
    const runtime = makeRuntime({
      send(message) {
        messages.push(message);
        if (message._tag !== "Request") return;
        const value =
          message.tag === "vscode.acquire"
            ? { id: "a".repeat(64), endpoint: "http://127.0.0.1:4321/" }
            : null;
        if (message.tag !== "vscode.acquire" && message.tag !== "vscodeViews.open")
          throw new Error(`Unexpected request: ${message.tag}`);
        const response: FromServerEncoded = {
          _tag: "Exit",
          requestId: message.id,
          exit: { _tag: "Success", value },
        };
        for (const listener of listeners) listener(response);
      },
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    });
    try {
      const client = makeClient(runtime);
      await client.vscode.open("/project");
      systemDark = true;
      await client.vscode.open("/project");
      const payloads = messages.flatMap((message) =>
        message._tag === "Request" ? [{ tag: message.tag, payload: message.payload }] : [],
      );
      const first = preference === "system" ? "light" : preference;
      const reopened = preference === "system" ? "dark" : preference;
      expect(payloads).toEqual([
        {
          tag: "vscode.acquire",
          payload: expect.objectContaining({ workspacePath: "/project", theme: first }),
        },
        {
          tag: "vscodeViews.open",
          payload: expect.objectContaining({ workspacePath: "/project", theme: first }),
        },
        {
          tag: "vscode.acquire",
          payload: expect.objectContaining({ workspacePath: "/project", theme: reopened }),
        },
        {
          tag: "vscodeViews.open",
          payload: expect.objectContaining({ workspacePath: "/project", theme: reopened }),
        },
      ]);
    } finally {
      await runtime.dispose();
    }
  },
);
