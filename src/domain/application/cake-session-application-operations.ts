import { Effect, Schema } from "effect";
import { compactDiscoveryGuidance } from "../../contracts/agent/discovery-result-text";

import { type JsonObject } from "../../contracts/serialization/json-contract";
import {
  CakeSettingsGetInput,
  CakeSettingsUpdateInput,
  windowSettingsGetHelp,
  windowSettingsUpdateHelp,
} from "../../contracts/application/cake-settings-schema";

import { SessionLabelColor } from "../../contracts/application/application-data";
import { SessionLabelListInput } from "../../contracts/application/backend-agent-control";
import { AgentListInput } from "../../contracts/agent/agent-list-data";
import { AgentProjectInfoInput } from "../../contracts/projects/agent-projects";

import type { RuntimeOperationApi } from "../../contracts/agent/cake-operation-api";
import type { CakeOperationDefinition } from "../../contracts/agent/cake-operation";

export function createSessionApplicationOperations(
  api: () => RuntimeOperationApi,
): CakeOperationDefinition[] {
  const empty = Schema.Struct({});
  const invokeAppControl =
    (command: string): CakeOperationDefinition["execute"] =>
    (input, context) => {
      // SAFETY: CakeOperationRegistry decoded input with the operation's object schema.
      return api().invokeAppControl(command, input as JsonObject, context.signal);
    };
  return [
    {
      command: "app.user-selection",
      requires: "invokeAppControl",
      topic: "app",
      summary: "Read highlighted Cake text",
      inputSchema: empty,
      examples: [{}],
      result: "The currently selected text, or no text if nothing is highlighted in Cake.",
      execute: (_input, context) =>
        api().invokeAppControl("app.user-selection", {}, context.signal),
    },
    {
      command: "app.state",
      requires: "invokeAppControl",
      topic: "app",
      summary: "Inspect window/view metadata",
      inputSchema: empty,
      examples: [{}],
      result:
        "Selection/focused conversation, current workspace, counts and workspaceView (browser location without credentials/query/fragment, or visible VS Code paths/groups). Hidden/loading/unavailable views do not imply current files. Canonical session IDs avoid global discovery; use projects.list/sessions.list for collections.",
      execute: (_input, context) => api().invokeAppControl("app.state", {}, context.signal),
    },
    {
      command: "projects.list",
      requires: "invokeAppControl",
      topic: "projects",
      summary: "List projects and Project Chat addresses",
      guidance: [compactDiscoveryGuidance],
      inputSchema: AgentListInput,
      examples: [{}],
      result:
        "Compact path/name/projectChatId rows, total and next=N; send to projectChatId with sessions.send. projects.info supplies timestamps.",
      execute: invokeAppControl("projects.list"),
    },
    {
      command: "projects.info",
      requires: "invokeAppControl",
      topic: "projects",
      summary: "Inspect registered project",
      inputSchema: AgentProjectInfoInput,
      examples: [{ input: { path: "/path/to/project" } }],
      result: "Project path, full name and timestamps.",
      execute: invokeAppControl("projects.info"),
    },
    {
      command: "app.workspace",
      requires: "invokeAppControl",
      topic: "app",
      summary: "Inspect/change Workspace pane",
      inputSchema: Schema.Struct({
        visible: Schema.optionalKey(Schema.Boolean),
        mode: Schema.optionalKey(Schema.Literals(["todos", "sessions"])),
      }),
      examples: [{}, { input: { mode: "sessions", visible: true } }, { input: { visible: false } }],
      result: "The canonical Workspace visibility and mode after the operation.",
      execute: invokeAppControl("app.workspace"),
    },
    {
      command: "app.home",
      requires: "invokeAppControl",
      topic: "app",
      summary: "Open Project Chat home",
      inputSchema: empty,
      examples: [{}],
      result: "Whether Project Chat or global Cake Chat was opened.",
      execute: invokeAppControl("app.home"),
    },
    {
      command: "settings.window.get",
      requires: "invokeAppControl",
      topic: "settings",
      summary: windowSettingsGetHelp.summary,
      inputSchema: CakeSettingsGetInput,
      examples: [{ input: { section: "appearance" } }],
      result: "The section's effective current settings and window scope.",
      execute: invokeAppControl("settings.window.get"),
    },
    {
      command: "settings.window.update",
      requires: "invokeAppControl",
      topic: "settings",
      summary: windowSettingsUpdateHelp.summary,
      guidance: windowSettingsUpdateHelp.guidance,
      inputSchema: CakeSettingsUpdateInput,
      examples: windowSettingsUpdateHelp.examples,
      result:
        "The section's committed effective settings after window-state persistence completes.",
      execute: invokeAppControl("settings.window.update"),
    },
    {
      command: "session-labels.list",
      requires: "invokeAppControl",
      topic: "session-labels",
      summary: "List session labels",
      guidance: [
        "Filter by name with query. projectPath selects its labels plus global labels; offset/limit page results.",
      ],
      inputSchema: SessionLabelListInput,
      examples: [{}],
      result: "Label IDs, names, colors and scopes, total and nextOffset (null at the end).",
      execute: invokeAppControl("session-labels.list"),
    },
    {
      command: "session-labels.add",
      requires: "invokeAppControl",
      topic: "session-labels",
      summary: "Add session label",
      guidance: ["Omit projectPath to create a global label available in every Project."],
      inputSchema: Schema.Struct({
        name: Schema.Trim.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(40))),
        color: SessionLabelColor,
        projectPath: Schema.optionalKey(
          Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4_096)),
        ),
      }),
      examples: [
        { input: { name: "In review", color: "cyan" } },
        {
          input: {
            name: "Ready to deploy",
            color: "green",
            projectPath: "/path/to/project",
          },
        },
      ],
      result: "The added session label and its scope.",
      execute: invokeAppControl("session-labels.add"),
    },
    {
      command: "session-labels.update",
      requires: "invokeAppControl",
      topic: "session-labels",
      summary: "Rename/recolor label",
      inputSchema: Schema.Struct({
        labelId: Schema.String.check(Schema.isUUID(4)),
        name: Schema.optionalKey(
          Schema.Trim.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(40))),
        ),
        color: Schema.optionalKey(SessionLabelColor),
      }),
      examples: [
        {
          input: {
            labelId: "00000000-0000-4000-8000-000000000001",
            name: "In review",
            color: "cyan",
          },
        },
      ],
      result: "The updated session label and its scope.",
      execute: invokeAppControl("session-labels.update"),
    },
    {
      command: "session-labels.remove",
      requires: "invokeAppControl",
      topic: "session-labels",
      summary: "Delete label and assignments",
      inputSchema: Schema.Struct({ labelId: Schema.String.check(Schema.isUUID(4)) }),
      examples: [{ input: { labelId: "00000000-0000-4000-8000-000000000001" } }],
      result: "The removed session label and its former scope.",
      execute: invokeAppControl("session-labels.remove"),
    },
    {
      command: "session-labels.reorder",
      requires: "invokeAppControl",
      topic: "session-labels",
      summary: "Reorder label (zero-based)",
      inputSchema: Schema.Struct({
        labelId: Schema.String.check(Schema.isUUID(4)),
        index: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(99)),
      }),
      examples: [{ input: { labelId: "00000000-0000-4000-8000-000000000001", index: 0 } }],
      result: "The reordered session label and its scope.",
      execute: invokeAppControl("session-labels.reorder"),
    },
    {
      command: "notifications.send",
      requires: "invokeAppControl",
      topic: "notifications",
      summary: "Send system notification",
      inputSchema: Schema.Struct({
        title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
        body: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2_000)),
        level: Schema.Literals(["info", "success", "warning", "error"]).pipe(
          Schema.withDecodingDefaultKey(Effect.succeed("info" as const)),
        ),
      }),
      examples: [
        {
          input: {
            title: "Authentication refactor complete",
            body: "The implementation and focused tests are ready for review.",
            level: "success",
          },
        },
      ],
      result: "A queued status after Cake accepts the notification for debounced delivery.",
      limitations: [
        "Notifications are debounced per calling session, so only the latest message in a burst is delivered.",
        "Notifications do not impersonate user input or enter another session transcript.",
      ],
      execute: invokeAppControl("notifications.send"),
    },
  ];
}
