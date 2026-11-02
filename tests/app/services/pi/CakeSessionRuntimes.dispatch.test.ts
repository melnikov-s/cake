import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Context, Effect, Layer, Ref } from "effect";
import { describe } from "vitest";
import {
  CAKE_CHAT_SESSION_ID,
  cakeChatSideChatSessionId,
} from "../../../../src/contracts/cake-chats/cake-chat-identity";
import {
  CakeSessionRuntimes,
  makeCakeSessionRuntimesLive,
  type CakeSessionRuntimeAcquireOptions,
  type CakeSessionRuntimeSetup,
} from "../../../../src/services/pi/CakeSessionRuntimes";
import { CakeChatDurable } from "../../../../src/services/pi-durable/CakeChatDurable";
import {
  fakeRuntime,
  makeRuntimeRecoveryStorageTestLayer,
  options,
} from "../../helpers/piRuntimeFixture";

const projectChatId = `project-chat:${"a".repeat(64)}`;
const globalControl = { tools: [], invoke: async () => ({ ok: true }) };

const cases: ReadonlyArray<{
  name: string;
  sessionId: string;
  profile: CakeSessionRuntimeAcquireOptions["profile"];
  inheritGlobalControl: boolean;
  expected: "regular" | "coordinator" | "side-chat";
}> = [
  ...[CAKE_CHAT_SESSION_ID, projectChatId].map((parent) => ({
    name: `${parent === CAKE_CHAT_SESSION_ID ? "global" : "project"} side chat with inherited controls`,
    sessionId: cakeChatSideChatSessionId(2, parent),
    profile: { _tag: "DiscussionSession" as const },
    inheritGlobalControl: true,
    expected: "side-chat" as const,
  })),
  ...[CAKE_CHAT_SESSION_ID, projectChatId].map((sessionId) => ({
    name: `${sessionId === CAKE_CHAT_SESSION_ID ? "global" : "project"} permanent chat`,
    sessionId,
    profile: { _tag: "CakeChatSession" as const },
    inheritGlobalControl: true,
    expected: "coordinator" as const,
  })),
  {
    name: "regular Project Session",
    sessionId: "project-session",
    profile: { _tag: "ProjectSession" },
    inheritGlobalControl: false,
    expected: "regular",
  },
  {
    name: "regular Pi sidecar",
    sessionId: "project-discussion",
    profile: { _tag: "DiscussionSession" },
    inheritGlobalControl: false,
    expected: "regular",
  },
];

describe("CakeSessionRuntimes engine dispatch", () => {
  for (const item of cases) {
    it.effect(`preserves conversation identity for ${item.name}`, () =>
      Effect.gen(function* () {
        const calls = yield* Ref.make<
          ReadonlyArray<{ engine: string; options: CakeSessionRuntimeSetup }>
        >([]);
        const construct = (engine: string, runtimeOptions: CakeSessionRuntimeSetup) =>
          Ref.update(calls, (current) => [...current, { engine, options: runtimeOptions }]).pipe(
            Effect.as(fakeRuntime(runtimeOptions, () => undefined)),
          );
        const layer = makeCakeSessionRuntimesLive((runtimeOptions) =>
          Effect.runPromise(construct("regular", runtimeOptions)),
        ).pipe(
          Layer.provide(
            Layer.mock(CakeChatDurable, {
              createRuntime: (runtimeOptions) => construct("coordinator", runtimeOptions),
              createSideChatRuntime: (runtimeOptions) => construct("side-chat", runtimeOptions),
            }),
          ),
          Layer.provide(makeRuntimeRecoveryStorageTestLayer()),
        );
        const context = yield* Layer.build(layer);
        const sessions = Context.get(context, CakeSessionRuntimes);
        yield* sessions.acquire({
          ...options({
            sessionId: item.sessionId,
            ...(item.inheritGlobalControl ? { globalControl } : {}),
          }),
          profile: item.profile,
        });
        const actual = yield* Ref.get(calls);
        assert.equal(actual.length, 1);
        assert.equal(actual[0]?.engine, item.expected);
        assert.equal(actual[0]?.options.sessionId, item.sessionId);
        assert.equal(
          actual[0]?.options.globalControl,
          item.inheritGlobalControl ? globalControl : undefined,
        );
      }),
    );
  }
});
