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
      summary: "Read the text currently highlighted by the user in the Cake window.",
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
      summary: "Inspect the invoking Cake window's selection, layout and collection counts.",
      inputSchema: empty,
      examples: [{}],
      result:
        "Current selection/layout and project/session counts. Discover collections with projects.list or sessions.list.",
      execute: (_input, context) => api().invokeAppControl("app.state", {}, context.signal),
    },
    {
      command: "projects.list",
      requires: "invokeAppControl",
      topic: "projects",
      summary: "List a bounded page of registered Project names and exact paths.",
      guidance: [compactDiscoveryGuidance],
      inputSchema: AgentListInput,
      examples: [{}],
      result:
        "Compact path/name rows, total and next=N; projects.info supplies trust and timestamps.",
      execute: invokeAppControl("projects.list"),
    },
    {
      command: "projects.info",
      requires: "invokeAppControl",
      topic: "projects",
      summary: "Inspect one registered Project by its exact path.",
      inputSchema: AgentProjectInfoInput,
      examples: [{ input: { path: "/path/to/project" } }],
      result: "Project path, full name, timestamps and Pi resource trust.",
      execute: invokeAppControl("projects.info"),
    },
    {
      command: "app.split",
      requires: "invokeAppControl",
      topic: "app",
      summary: "Split the calling conversation pane and open a new chat in it.",
      guidance: ["Splits are relative to the calling conversation's pane."],
      inputSchema: Schema.Struct({ direction: Schema.Literals(["right", "down"]) }),
      examples: [{ input: { direction: "right" } }],
      result: "The new pane and conversation identity.",
      execute: invokeAppControl("app.split"),
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
      summary: "List a bounded page of global and project-specific session labels.",
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
      summary: "Add a global or project-specific session label.",
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
      summary: "Rename or recolor an existing session label.",
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
      summary: "Remove a session label and clear it from every session that uses it.",
      inputSchema: Schema.Struct({ labelId: Schema.String.check(Schema.isUUID(4)) }),
      examples: [{ input: { labelId: "00000000-0000-4000-8000-000000000001" } }],
      result: "The removed session label and its former scope.",
      execute: invokeAppControl("session-labels.remove"),
    },
    {
      command: "session-labels.reorder",
      requires: "invokeAppControl",
      topic: "session-labels",
      summary: "Move a global or project-specific label to a new zero-based position.",
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
      summary: "Send a bounded native system notification through the operating system.",
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
