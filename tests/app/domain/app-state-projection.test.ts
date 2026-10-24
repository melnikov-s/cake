import { it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { expect, vi } from "vitest";
import { safeCoordinatorProjection } from "../../../src/domain/cake-chats/taskInputControls";
import { TaskInputStorage } from "../../../src/services/storage/TaskInputStorage";

it.effect("preserves visible window metadata but still protects task session content", () => {
  const sessionId = "11111111-1111-4111-8111-111111111111";
  const isRecipient = vi.fn(() => Effect.succeed(true));
  return Effect.gen(function* () {
    const result = yield* safeCoordinatorProjection({
      ok: true,
      command: "app.state",
      state: {
        selection: { kind: "project-session", sessionId, title: "PRIVATE_TITLE" },
        workspaceView: {
          kind: "vscode",
          sessionId,
          status: "ready",
          paneId: "pane",
          editors: [{ path: "src/main.ts", group: 2, active: true, text: "PRIVATE_CONTENT" }],
          text: "PRIVATE_CONTENT",
        },
      },
    });
    expect(result).toEqual({
      ok: true,
      command: "app.state",
      state: {
        selection: { sessionId, title: "Task session" },
        workspaceView: {
          kind: "vscode",
          sessionId,
          status: "ready",
          paneId: "pane",
          editors: [{ path: "src/main.ts", group: 2, active: true }],
        },
      },
    });
    expect(isRecipient).toHaveBeenCalledTimes(1);
  }).pipe(Effect.provide(Layer.mock(TaskInputStorage, { isRecipient })));
});
