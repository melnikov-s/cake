import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Effect, Stream } from "effect";
import { describe, expect } from "vitest";
import {
  deliver,
  deliverWhenAvailable,
  projectQueuedMessages,
} from "../../../src/domain/conversations/conversations";
import type { PiSessionHandle } from "../../../src/services/pi/PiSessions";
import type { SessionSnapshot } from "../../../src/ipc/session-contract";

const snapshot = (streaming: boolean): SessionSnapshot => ({
  workspacePath: "/project",
  sessionId: "session-1",
  sessionFile: "/sessions/session-1.jsonl",
  parts: [],
  models: [],
  thinkingLevel: "off",
  availableThinkingLevels: ["off"],
  streaming,
  diagnostics: [],
  commands: [],
  compatibility: { resources: [], diagnostics: [] },
  extensionUi: { statuses: [] },
  tree: [],
});

const makeHandle = (deliveries: string[], isStreaming: () => boolean): PiSessionHandle => ({
  updates: Stream.empty,
  snapshot: () => Effect.succeed(snapshot(isStreaming())),
  prompt: () => Effect.sync(() => deliveries.push("prompt")).pipe(Effect.as("prompt-turn")),
  steer: () => Effect.sync(() => deliveries.push("steer")).pipe(Effect.as("steer-turn")),
  followUp: () => Effect.sync(() => deliveries.push("follow-up")).pipe(Effect.as("follow-up-turn")),
  listQueuedMessages: () => Effect.succeed({ steering: [], followUp: [] }),
  clearQueue: () => Effect.succeed({ steering: [], followUp: [] }),
  cancelSteering: () => Effect.succeed({ steering: [], followUp: [] }),
  editMessage: () => Effect.void,
  setUserMessageMarkdown: () => Effect.void,
  abort: () => Effect.void,
  executeCommand: () => Effect.succeed(undefined),
  applyConfiguration: () => Effect.void,
  setModel: () => Effect.void,
  setFastMode: () => Effect.void,
  setThinkingLevel: () => Effect.void,
  setPiSetting: () => Effect.void,
  login: () => Effect.void,
  logout: () => Effect.void,
  navigate: () => Effect.void,
  compact: () => Effect.void,
  rename: () => Effect.void,
  fork: () => Effect.die("Unexpected fork"),
  handoff: () => Effect.die("Unexpected handoff"),
  reviewParentContext: () => Effect.die("Unexpected parent-context request"),
  notifySubagentCompletion: () => Effect.void,
  reload: () => Effect.void,
});

describe("conversation domain", () => {
  it("maps Pi queue state into a detached Cake conversation value", () => {
    const piQueue = { steering: ["change direction"], followUp: ["do this next"] };

    const projected = projectQueuedMessages(piQueue);
    piQueue.steering.push("later");

    expect(projected).toEqual({
      steering: ["change direction"],
      followUp: ["do this next"],
    });
  });

  it.effect("acquires at use time and preserves each Pi delivery mode", () =>
    Effect.gen(function* () {
      const deliveries: string[] = [];
      let acquisitions = 0;
      const handle = makeHandle(deliveries, () => false);
      const acquire = () =>
        Effect.sync(() => {
          acquisitions += 1;
          return handle;
        });

      assert.equal(yield* deliver(acquire(), "prompt", "one", [], false), "prompt-turn");
      assert.equal(yield* deliver(acquire(), "steer", "two", [], false), "steer-turn");
      assert.equal(yield* deliver(acquire(), "follow-up", "three", [], false), "follow-up-turn");
      assert.equal(acquisitions, 3);
      assert.deepEqual(deliveries, ["prompt", "steer", "follow-up"]);
    }),
  );

  it.effect("queues busy automatic delivery as a follow-up", () =>
    Effect.gen(function* () {
      const deliveries: string[] = [];
      const handle = makeHandle(deliveries, () => true);

      const turnId = yield* deliverWhenAvailable(Effect.succeed(handle), "next", [], false);

      assert.equal(turnId, "follow-up-turn");
      assert.deepEqual(deliveries, ["follow-up"]);
    }),
  );
});
