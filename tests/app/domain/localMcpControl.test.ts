import { it } from "@effect/vitest";
import { expect } from "vitest";
import { Context, Effect, Schema } from "effect";
import { invoke, commandsForGrant } from "../../../src/domain/mcp/localMcpControl";
import { type LocalMcpConfiguration } from "../../../src/contracts/mcp/local-mcp";
import { SessionFamilyStorage } from "../../../src/services/storage/SessionFamilyStorage";
import { ApplicationState } from "../../../src/services/storage/ApplicationState";
import { projectChatSessionId } from "../../../src/domain/cake-chats/cakeChatLocations";
import { localMcpFixture as fixture, localMcpTarget as target } from "../helpers/localMcpHarness";
import type { JsonObject } from "../../../src/contracts/serialization/json-contract";

const grant: LocalMcpConfiguration = { enabled: true, port: 0, projects: ["/project"] };
const writable = { ...grant, scopes: ["read", "launch", "send", "todos.write"] as const };

it.effect("defaults to read-only and authorizes direct calls, not only discovery", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    expect(commandsForGrant(grant).map((tool) => tool.name)).not.toContain("sessions.create");
    const result = yield* invoke(grant, "sessions.create", {
      projectPath: "/project",
      name: "Task",
      initialPrompt: "Work",
    }).pipe(Effect.result, Effect.provide(f.context));
    expect(result).toMatchObject({ _tag: "Failure", failure: { code: "denied" } });
    for (const name of ["sessions.send", "todos.create", "todos.update"]) {
      expect(
        yield* invoke(grant, name, {}).pipe(Effect.result, Effect.provide(f.context)),
      ).toMatchObject({ _tag: "Failure", failure: { code: "denied" } });
    }
    expect(commandsForGrant({ ...grant, scopes: [] })).toEqual([]);
    expect(
      yield* invoke({ ...grant, scopes: [] }, "projects.list", {}).pipe(
        Effect.result,
        Effect.provide(f.context),
      ),
    ).toMatchObject({ _tag: "Failure", failure: { code: "denied" } });
    expect(f.calls).toEqual([]);
  }),
);

it.effect("filters registry discovery before pagination and restricts every project target", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const application = Context.get(f.context, ApplicationState);
    yield* application.transact((state) =>
      Effect.succeed({
        ...state,
        projects: [
          ...state.projects,
          { path: "/other", name: "Other", addedAt: "2026-01-01", lastOpenedAt: "2026-01-01" },
        ],
      }),
    );
    const result = yield* invoke(grant, "projects.list", {}).pipe(Effect.provide(f.context));
    expect(result).toMatchObject({ total: 1, projects: [{ path: "/project" }] });
    for (const name of ["projects.info", "sessions.list", "todos.list", "sessions.create"]) {
      const denied = yield* invoke(
        writable,
        name,
        name === "sessions.create"
          ? { projectPath: "/other", name: "Task", initialPrompt: "Work" }
          : { projectPath: "/other" },
      ).pipe(Effect.result, Effect.provide(f.context));
      expect(denied).toMatchObject({ _tag: "Failure", failure: { code: "denied" } });
    }
    expect(f.calls).toEqual([]);
  }),
);

it.effect("rejects a foreign canonical session ID even when both Projects are granted", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    yield* f.state.transact((state) =>
      Effect.succeed({
        ...state,
        trustedProjectPaths: ["/project", "/other"],
        projects: [
          ...state.projects,
          { path: "/other", name: "Other", addedAt: "2026-01-01", lastOpenedAt: "2026-01-01" },
        ],
      }),
    );
    for (const name of ["sessions.info", "sessions.history", "sessions.send"]) {
      const input: JsonObject =
        name === "sessions.send"
          ? { projectPath: "/other", sessionId: target, text: "Work" }
          : { projectPath: "/other", sessionId: target };
      const result = yield* invoke(
        { ...writable, projects: ["/project", "/other"] },
        name,
        input,
      ).pipe(Effect.result, Effect.provide(f.context));
      expect(result).toMatchObject({ _tag: "Failure", failure: { code: "denied" } });
    }
    expect(f.calls).toEqual([]);
  }),
);

it.effect("preserves ordinary history and Project Chat report reads", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const family = Context.get(f.context, SessionFamilyStorage);
    yield* family.deferReferenceNotice({
      id: "report-1",
      recipientSessionId: projectChatSessionId("/project"),
      text: "Original report",
    });
    const history = yield* invoke(grant, "sessions.history", {
      projectPath: "/project",
      sessionId: target,
    }).pipe(Effect.provide(f.context));
    expect(Schema.decodeUnknownSync(Schema.String)(history)).toContain("Original history");
    const list = yield* invoke(grant, "sessions.reports", { projectPath: "/project" }).pipe(
      Effect.provide(f.context),
    );
    expect(Schema.decodeUnknownSync(Schema.String)(list)).toContain("report-1");
    const report = yield* invoke(grant, "sessions.reports.read", {
      projectPath: "/project",
      id: "report-1",
    }).pipe(Effect.provide(f.context));
    expect(Schema.decodeUnknownSync(Schema.String)(report)).toContain("Original report");
  }),
);

it.effect("does not bypass the Project Chat task-input content boundary", () =>
  Effect.gen(function* () {
    const f = yield* fixture([target]);
    const result = yield* invoke(grant, "sessions.history", {
      projectPath: "/project",
      sessionId: target,
    }).pipe(Effect.provide(f.context));
    expect(JSON.parse(Schema.decodeUnknownSync(Schema.String)(result))).toMatchObject({
      ok: false,
      error: expect.stringContaining("task inputs"),
    });
  }),
);

it.effect("rechecks registration and trust on each call, never granting either", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const application = Context.get(f.context, ApplicationState);
    yield* application.transact((state) => Effect.succeed({ ...state, trustedProjectPaths: [] }));
    expect(
      yield* invoke(writable, "sessions.create", {
        projectPath: "/project",
        name: "Task",
        initialPrompt: "Work",
      }).pipe(Effect.result, Effect.provide(f.context)),
    ).toMatchObject({ _tag: "Failure", failure: { code: "denied" } });
    expect(
      yield* invoke(grant, "projects.info", { projectPath: "/project" }).pipe(
        Effect.provide(f.context),
      ),
    ).toMatchObject({ project: { trusted: false } });
    yield* application.transact((state) => Effect.succeed({ ...state, projects: [] }));
    expect(
      yield* invoke(grant, "projects.info", { projectPath: "/project" }).pipe(
        Effect.result,
        Effect.provide(f.context),
      ),
    ).toMatchObject({ _tag: "Failure", failure: { code: "denied" } });
    expect(f.calls).toEqual([]);
  }),
);

it.effect(
  "forwards bounded launch/send/to-do calls to the selected canonical Project Chat operation",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const launch = yield* invoke(writable, "sessions.create", {
        projectPath: "/project",
        name: "Task",
        initialPrompt: "Work",
      }).pipe(Effect.provide(f.context));
      expect(JSON.parse(Schema.decodeUnknownSync(Schema.String)(launch))).toMatchObject({
        ok: true,
        command: "sessions.create",
        status: "started",
        sessionId: expect.any(String),
      });
      yield* invoke(writable, "sessions.send", {
        projectPath: "/project",
        sessionId: target,
        text: "Continue",
      }).pipe(Effect.provide(f.context));
      yield* invoke(writable, "todos.create", {
        projectPath: "/project",
        title: "Task",
        description: "Work underway",
      }).pipe(Effect.provide(f.context));
      expect(f.calls).toEqual([
        {
          name: "sessions.create",
          input: {
            workspacePath: "/project",
            name: "Task",
            initialPrompt: "Work",
          },
        },
        { name: "sessions.send", input: { sessionId: target, text: "Continue" } },
        { name: "todos.create", input: { title: "Task", description: "Work underway" } },
      ]);
    }),
);

it.effect(
  "rejects nested operations, approval fields, prompt-file forwarding and noncanonical targets",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      for (const name of [
        "sessions.cake",
        "projects.request-trust",
        "settings.get",
        "worktrees.merge",
        "sessions.resolve",
        "bash",
      ]) {
        const result = yield* invoke(writable, name, {}).pipe(
          Effect.result,
          Effect.provide(f.context),
        );
        expect(result).toMatchObject({ _tag: "Failure", failure: { code: "unsupported" } });
      }
      const extras: JsonObject[] = [
        { approved: true },
        { promptFiles: ["/secret"] },
        { inputRefs: [] },
        { workspacePath: "/other" },
      ];
      for (const extra of extras) {
        const result = yield* invoke(writable, "sessions.create", {
          projectPath: "/project",
          name: "Task",
          initialPrompt: "Work",
          ...extra,
        }).pipe(Effect.result, Effect.provide(f.context));
        expect(result).toMatchObject({ _tag: "Failure", failure: { code: "invalid_input" } });
      }
      for (const sessionId of ["cake-chat", "short-id", projectChatSessionId("/other")]) {
        const result = yield* invoke(writable, "sessions.send", {
          projectPath: "/project",
          sessionId,
          text: "Work",
        }).pipe(Effect.result, Effect.provide(f.context));
        expect(result).toMatchObject({ _tag: "Failure", failure: { code: "denied" } });
      }
      expect(f.calls).toEqual([]);
    }),
);
