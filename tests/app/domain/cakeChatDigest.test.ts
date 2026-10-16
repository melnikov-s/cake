import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { describe } from "vitest";
import {
  prepareUserMessage,
  runStartedByReport,
} from "../../../src/domain/cake-chats/cakeChatDigest";
import {
  formatSessionDigestReminder,
  splitSessionDigestReminder,
} from "../../../src/contracts/cake-chats/session-digest-reminder";
import { CAKE_CHAT_SESSION_ID } from "../../../src/contracts/cake-chats/cake-chat-identity";
import type { UiPart } from "../../../src/contracts/conversations/session-contract";
import {
  CakeSessionRuntimes,
  type CakeSessionHandle,
} from "../../../src/services/pi/CakeSessionRuntimes";
import { ProjectSessionConfiguration } from "../../../src/services/project-sessions/ProjectSessionConfiguration";
import { SessionFamilyStorage } from "../../../src/services/storage/SessionFamilyStorage";
import { familyStorageHarness } from "../helpers/familyStorageHarness";
import { snapshot } from "../helpers/piRuntimeFixture";

const reportId = "2b7e6c1a-9d4f-4e0b-8a3c-1f5d7e9b2c40";
const runningId = "5c8a1e3b-7f2d-4b6e-9c0a-3d1f5e7b9a21";
type TextPart = Extract<UiPart, { kind: "text" }>;
const userText = (text: string): TextPart => ({
  id: `user-${text}`,
  kind: "text",
  role: "user",
  text,
  status: "complete",
});
const reportPart: TextPart = {
  id: "report",
  kind: "text",
  role: "user",
  text: "Session finished",
  status: "complete",
  crossSession: {
    version: 1,
    messageId: "6d2f8b4c-1a3e-4c5d-9e7f-0b2a4c6e8d10",
    threadId: "6d2f8b4c-1a3e-4c5d-9e7f-0b2a4c6e8d10",
    sequence: 1,
    expectsResponse: false,
    sender: { sessionId: reportId, title: "Session", kind: "project-session" },
  },
};

const coordinator = (streaming: boolean, parts: UiPart[]) => {
  const calls: string[] = [];
  const handle = {
    profile: "CakeChatSession",
    snapshot: () =>
      Effect.succeed({ ...snapshot, sessionId: CAKE_CHAT_SESSION_ID, streaming, parts }),
    abort: () =>
      Effect.sync(() => {
        calls.push("abort");
      }),
  } satisfies Partial<CakeSessionHandle>;
  // SAFETY: prepareUserMessage only reads the snapshot and may abort the active run.
  return { handle: handle as unknown as CakeSessionHandle, calls };
};

const environment = (running: readonly string[] = []) => {
  const harness = familyStorageHarness();
  return Layer.mergeAll(
    harness.layer,
    Layer.mock(CakeSessionRuntimes, {
      currentStatus: (target) =>
        Effect.succeed(
          running.includes(target.sessionId)
            ? { streaming: true, pending: false, persisted: true }
            : { streaming: false, pending: false, persisted: true },
        ),
    }),
    Layer.succeed(ProjectSessionConfiguration, {
      agentDirectory: "/agent",
      sessionDirectory: "/sessions",
      resolvedSessionDirectory: "/resolved",
    }),
  );
};

const seed = Effect.fn("CakeChatDigestTest.seed")(function* () {
  const storage = yield* SessionFamilyStorage;
  for (const sessionId of [reportId, runningId])
    yield* storage.registerSpawn({
      sessionId,
      projectPath: "/project",
      workingDirectory: "/project",
      requester: { sessionId: CAKE_CHAT_SESSION_ID, kind: "cake-chat", title: "Cake Chat" },
      reportDelivered: false,
      handoffSettled: false,
    });
  yield* storage.recordTurn({
    sessionId: reportId,
    senderSessionId: CAKE_CHAT_SESSION_ID,
    turnId: "turn-1",
    requestMessageId: reportId,
    threadId: reportId,
    reported: false,
    outcome: "complete",
    reportPolicy: "digest",
  });
  yield* storage.digestNotice("turn-1", {
    id: "turn-1",
    sessionId: reportId,
    title: "fix-x",
    status: "failed",
    summary: "Typecheck failed in src/app.ts",
    reportedAt: "2026-01-01T00:00:00.000Z",
  });
});

describe("Cake Chat user priority and digest reminders", () => {
  it("identifies runs started by a session report or worker result, not by the user", () => {
    assert.equal(runStartedByReport([userText("hi"), reportPart]), true);
    assert.equal(runStartedByReport([reportPart, userText("actually, stop")]), false);
    assert.equal(
      runStartedByReport([
        {
          ...userText("hi"),
          // SAFETY: only the presence of worker provenance matters here.
          subagentReport: { task: "Review" } as TextPart["subagentReport"],
        },
      ]),
      true,
    );
    // A queued user message does not own the active run.
    assert.equal(
      runStartedByReport([reportPart, { ...userText("queued"), deliveryState: "queued" }]),
      true,
    );
    assert.equal(runStartedByReport([]), false);
  });

  it.effect("a user message stops a report-triggered run and says so in the reminder", () =>
    Effect.gen(function* () {
      const { handle, calls } = coordinator(true, [userText("earlier"), reportPart]);
      const prepared = yield* prepareUserMessage(handle, "Unrelated question");
      assert.deepEqual(calls, ["abort"]);
      assert.equal(prepared.interruptedReport, true);
      assert.deepEqual(prepared.digestIds, []);
      const split = splitSessionDigestReminder(prepared.text);
      assert.equal(split.text, "Unrelated question");
      assert.match(split.reminder ?? "", /Answer the user first and fold in anything important/);
    }).pipe(Effect.provide(environment())),
  );

  it.effect("a user-started run is never interrupted and an empty inbox adds nothing", () =>
    Effect.gen(function* () {
      const { handle, calls } = coordinator(true, [reportPart, userText("my own question")]);
      const prepared = yield* prepareUserMessage(handle, "Follow-up");
      assert.deepEqual(calls, []);
      assert.equal(prepared.text, "Follow-up");
      const idle = coordinator(false, [reportPart]);
      assert.equal((yield* prepareUserMessage(idle.handle, "Hello")).text, "Hello");
      assert.deepEqual(idle.calls, []);
    }).pipe(Effect.provide(environment())),
  );

  it.effect("the digest lists each result once with a link and the running count", () =>
    Effect.gen(function* () {
      yield* seed();
      const { handle } = coordinator(false, []);
      const prepared = yield* prepareUserMessage(handle, "What's going on?");
      assert.deepEqual(prepared.digestIds, ["turn-1"]);
      const split = splitSessionDigestReminder(prepared.text);
      assert.equal(split.text, "What's going on?");
      assert.equal(
        split.reminder,
        formatSessionDigestReminder({
          lines: [
            {
              reference: `s:${reportId.replaceAll("-", "").slice(-8)}`,
              sessionId: reportId,
              title: "fix-x",
              status: "failed",
              summary: "Typecheck failed in src/app.ts",
            },
          ],
          running: 1,
          interruptedReport: false,
        }),
      );
      assert.match(split.reminder ?? "", /\[fix-x\]\(cake:\/\/session\/2b7e6c1a/);
      assert.match(split.reminder ?? "", /failed: Typecheck failed/);
      assert.match(split.reminder ?? "", /1 session you launched is still running\./);
    }).pipe(Effect.provide(environment([runningId]))),
  );

  it("only strips the exact Cake-owned block at the start of a message", () => {
    const reminder = formatSessionDigestReminder({
      lines: [],
      running: 0,
      interruptedReport: true,
    });
    assert.ok(reminder);
    assert.deepEqual(splitSessionDigestReminder(`${reminder}\n\nHello`), {
      text: "Hello",
      reminder,
    });
    const quoted = `Hello\n\n${reminder}`;
    assert.deepEqual(splitSessionDigestReminder(quoted), { text: quoted, reminder: undefined });
    assert.equal(
      formatSessionDigestReminder({ lines: [], running: 3, interruptedReport: false }),
      undefined,
    );
  });
});
