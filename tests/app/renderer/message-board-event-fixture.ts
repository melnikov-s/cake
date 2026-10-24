import { Layer } from "effect";
import type { RequestEncoded, FromServerEncoded } from "effect/unstable/rpc/RpcMessage";
import type { artifactEventSchema } from "../../../src/contracts/application/cake-rpc-contract";
import { ClientEvents } from "../../../src/services/clients/ClientEvents";
import { observeArtifactEvents } from "../../../src/renderer/observers";
import { makeRuntime } from "../../../src/renderer/runtime";
import type { RootStore } from "../../../src/renderer/stores/RootStore";

/** Keeps domain broadcasts, validated event decoding and the real renderer router in workflow tests. */
export function messageBoardEvents() {
  type Event = typeof artifactEventSchema.Type;
  const listeners = new Set<(message: unknown) => void>();
  let requestId: RequestEncoded["id"] | undefined;
  const respond = (message: FromServerEncoded) => {
    for (const listener of listeners) listener(message);
  };
  const emit = (event: Event) => {
    if (requestId !== undefined) respond({ _tag: "Chunk", requestId, values: [event] });
  };
  const layer = Layer.mock(ClientEvents, {
    sendTo: () => false,
    broadcast: (event) => {
      if (
        event.type === "message-board-invalidated" ||
        event.type === "artifact-catalog-invalidated"
      )
        emit(event);
    },
  });
  const runtime = makeRuntime({
    send(message) {
      if (message._tag === "Interrupt" && message.requestId === requestId) requestId = undefined;
      if (message._tag !== "Request") return;
      if (message.tag === "artifacts.observeEvents") {
        requestId = message.id;
        emit({ type: "renderer-events-ready", channel: "artifacts" });
      } else throw new Error(`Unexpected event fixture request: ${message.tag}`);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
  return {
    layer,
    observe: (root: RootStore) => observeArtifactEvents(runtime, root),
    reconnect: () => emit({ type: "renderer-events-ready", channel: "artifacts" }),
    dispose: () => runtime.dispose(),
  };
}
