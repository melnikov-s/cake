import type {
  ExitEncoded,
  FromClientEncoded,
  RequestEncoded,
} from "effect/unstable/rpc/RpcMessage";
import { makeRuntime } from "../../../src/renderer/runtime";
import type { ElectronRpcTransport } from "../../../src/ipc/transport/ElectronRpcTransport";

/** Real renderer runtime/RPC adaptation; only the encoded transport is controlled. */
export function commandClientFinishTransport(
  respond: (request: RequestEncoded) => ExitEncoded<unknown, unknown>,
  afterResponse?: () => void,
) {
  const messages: FromClientEncoded[] = [];
  const listeners = new Set<Parameters<ElectronRpcTransport["subscribe"]>[0]>();
  const runtime = makeRuntime({
    send(message) {
      messages.push(message);
      if (message._tag !== "Request") return;
      const exit =
        message.tag === "vscodeViews.observeThemes"
          ? { _tag: "Success" as const, value: null }
          : respond(message);
      for (const listener of listeners) listener({ _tag: "Exit", requestId: message.id, exit });
      if (message.tag !== "vscodeViews.observeThemes") afterResponse?.();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
  return {
    runtime,
    requests() {
      return messages.filter(
        (message): message is RequestEncoded =>
          message._tag === "Request" && message.tag !== "vscodeViews.observeThemes",
      );
    },
    async [Symbol.asyncDispose]() {
      await runtime.dispose();
    },
  };
}
