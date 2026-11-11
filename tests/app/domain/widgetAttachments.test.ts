import { it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { expect, describe } from "vitest";
import { defaultApplicationState } from "../../../src/contracts/application/application-data";
import {
  assertWidgetCommand,
  widgetAppliesTo,
} from "../../../src/contracts/widgets/widget-attachment";
import * as attachments from "../../../src/domain/widgets/widgetAttachments";
import { forgetProjectSessions } from "../../../src/domain/application/application";
import { ApplicationState } from "../../../src/services/storage/ApplicationState";
import { ApplicationStorage } from "../../../src/services/storage/ApplicationStorage";
import { ArtifactStorage } from "../../../src/services/storage/ArtifactStorage";
import { widgetInstance } from "../helpers/widget-instance";
import { createWidgetAttachmentOperations } from "../../../src/domain/widgets/cake-widget-attachment-operations";
import { CakeOperationRegistry } from "../../../src/services/pi/runtime/cake-operation-registry";

const widget = widgetInstance();
const layer = () =>
  Layer.mergeAll(
    ApplicationState.layer.pipe(
      Layer.provide(
        Layer.succeed(ApplicationStorage, {
          load: () =>
            Effect.succeed({ state: defaultApplicationState(), source: "missing" as const }),
          save: () => Effect.void,
        }),
      ),
    ),
    Layer.mock(ArtifactStorage, {
      read: (id) => Effect.succeed(id === widget.revision.lineageId ? widget.revision : undefined),
    }),
  );
const request = {
  id: "attachment",
  lineageId: widget.revision.lineageId,
  slot: "bottom" as const,
  target: { kind: "global" as const },
};

it.effect(
  "moves/reorders/hides attachments without copying identity, state or background runtimes",
  () =>
    Effect.gen(function* () {
      yield* (yield* ApplicationState).initialize();
      yield* attachments.attach(request);
      yield* attachments.setHidden(request.id, true);
      yield* attachments.attach({ ...request, slot: "left" });
      yield* attachments.attach({ ...request, id: "neighbor", slot: "left" });
      const moved = yield* attachments.attach({ ...request, slot: "left", order: 1 });
      expect(moved.widgetAttachments.map((entry) => entry.id)).toEqual(["neighbor", "attachment"]);
      expect(moved.widgetAttachments[1]).toMatchObject({
        lineageId: request.lineageId,
        slot: "left",
        hidden: true,
      });
      const invalid = yield* Effect.result(
        attachments.attach({ ...request, lineageId: "missing" as typeof request.lineageId }),
      );
      expect(invalid._tag).toBe("Failure");
      expect((yield* (yield* ApplicationState).current()).widgetAttachments).toEqual(
        moved.widgetAttachments,
      );
      yield* attachments.detach(request.id);
      expect(
        (yield* (yield* ApplicationState).current()).widgetAttachments.map((entry) => entry.id),
      ).toEqual(["neighbor"]);
    }).pipe(Effect.provide(layer())),
);

it.effect("forgets only exact-session attachments; broad category attachments survive", () =>
  Effect.gen(function* () {
    yield* (yield* ApplicationState).initialize();
    yield* attachments.attach(request);
    yield* attachments.attach({
      ...request,
      id: "specific",
      target: { kind: "session", sessionId: "gone" },
    });
    const forgotten = yield* forgetProjectSessions(["gone"]);
    expect(forgotten.widgetAttachments.map((entry) => entry.id)).toEqual(["attachment"]);
  }).pipe(Effect.provide(layer())),
);

describe("widget applicability and authority", () => {
  it("uses categories across projects, not one project's children", () => {
    expect(widgetAppliesTo({ kind: "project-chats" }, "chat-a", "project-chat")).toBe(true);
    expect(widgetAppliesTo({ kind: "project-chats" }, "chat-b", "project-chat")).toBe(true);
    expect(widgetAppliesTo({ kind: "project-chats" }, "work", "project-session")).toBe(false);
    expect(widgetAppliesTo({ kind: "project-sessions" }, "work", "project-session")).toBe(true);
    expect(widgetAppliesTo({ kind: "project-sessions" }, "automation", "automation-session")).toBe(
      false,
    );
    expect(widgetAppliesTo({ kind: "session", sessionId: "one" }, "two", "project-session")).toBe(
      false,
    );
    expect(widgetAppliesTo({ kind: "global" }, "global-chat", "cake-chat")).toBe(true);
  });
  it("allows data tools, not attachment or permission management, including capability installation", () => {
    for (const command of [
      "sessions.list",
      "sessions.history",
      "widgets.attachments",
      "settings.widgets.list",
      "settings.labels.update",
      "artifacts.set-global",
    ])
      expect(() => assertWidgetCommand(command)).not.toThrow();
    for (const command of [
      "widgets.attach",
      "widgets.detach",
      "settings.widgets.install",
      "settings.mcp.update",
      "settings.providers.login",
    ])
      expect(() => assertWidgetCommand(command)).toThrow();
  });
  it("registers agent attachment operations independently of widget generation", async () => {
    const calls: string[] = [];
    const registry = new CakeOperationRegistry(
      createWidgetAttachmentOperations(async (command) => {
        calls.push(command);
        return { attached: true };
      }),
    );
    const result = await registry.invoke(
      { command: "widgets.attach", input: request },
      { signal: new AbortController().signal, toolCallId: "attach", runtime: {} },
    );
    expect(calls).toEqual(["widgets.attach"]);
    expect(result.json).toEqual({ attached: true });
  });
});
