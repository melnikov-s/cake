import type { ConversationSnapshot, UiPart } from "../../contracts/conversations/session-contract";
import type { CakeSessionRuntimeOptions } from "../pi/runtime/cake-session-runtime";
import { TurnCanceledError } from "../pi/runtime/RuntimeTurnCompletion";

/** UI cancellation is an acknowledgment, not the SDK's provider/tool join. The
 * owning Durable runtime still owns that join and must not admit another run
 * until it finishes. Only projected display values are retained here. */
export function createDurableTurnStop(options: {
  readonly stop: () => Promise<void>;
  readonly onEvent: CakeSessionRuntimeOptions["onEvent"];
  readonly publish: () => void;
  readonly isDisposed: () => boolean;
}) {
  let latest: ConversationSnapshot | undefined;
  let frozen: readonly UiPart[] | undefined;
  let stopped = false;
  let generation = 0;
  let cleanup: Promise<void> | undefined;
  let failed = false;

  const project = (snapshot: ConversationSnapshot): ConversationSnapshot => {
    latest = snapshot;
    if (!stopped) return snapshot;
    return {
      ...snapshot,
      streaming: false,
      parts: [
        ...(frozen ?? []),
        ...snapshot.parts.filter((part) => part.kind === "text" && part.deliveryState),
        ...(cleanup
          ? [
              {
                id: "abort-cleanup",
                kind: "notice" as const,
                tone: failed ? ("error" as const) : ("info" as const),
                title: failed ? "Cancellation cleanup failed" : "Cancellation requested",
                detail: failed
                  ? "Cleanup did not finish. New input cannot run in this session."
                  : "Provider or tool cleanup is still pending. New input will wait.",
              },
            ]
          : []),
      ],
    };
  };

  return {
    project,
    stopped: () => stopped,
    waitForStop: async () => {
      await cleanup;
    },
    async beforeInput() {
      const admitted = generation;
      if (cleanup) await cleanup;
      const assertCurrent = () => {
        if (options.isDisposed() || admitted !== generation)
          throw new TurnCanceledError("Session was aborted");
      };
      assertCurrent();
      stopped = false;
      frozen = undefined;
      return assertCurrent;
    },
    async abort() {
      generation += 1;
      if (cleanup) return;
      stopped = true;
      failed = false;
      frozen = latest?.parts
        .filter((part) => !(part.kind === "text" && part.deliveryState))
        .map((part) =>
          part.kind === "text" && part.status === "streaming"
            ? { ...part, status: "complete" as const }
            : part.kind === "tool" && part.state === "running"
              ? { ...part, state: "interrupted" as const }
              : part,
        );
      cleanup = options.stop();
      void cleanup.then(
        () => {
          cleanup = undefined;
          if (!options.isDisposed()) options.publish();
        },
        () => {
          // Retain the rejected gate: admitting new work would falsely assume idle.
          failed = true;
          if (!options.isDisposed()) options.publish();
        },
      );
      if (latest) options.onEvent({ type: "snapshot", snapshot: project(latest) });
    },
  };
}
