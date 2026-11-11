import { Schema } from "effect";
import { ArtifactLineageId } from "../artifacts/artifact-lineage";

export const WidgetSlot = Schema.Literals(["top", "bottom", "left", "right"]);
export type WidgetSlot = typeof WidgetSlot.Type;

export const WidgetTarget = Schema.Union([
  Schema.Struct({ kind: Schema.Literals(["global", "project-chats", "project-sessions"]) }),
  Schema.Struct({
    kind: Schema.Literal("session"),
    sessionId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  }),
]);
export type WidgetTarget = typeof WidgetTarget.Type;

/** Placement references an existing instance; it never copies its state or starts a runtime. */
export const WidgetAttachment = Schema.Struct({
  id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  lineageId: ArtifactLineageId,
  target: WidgetTarget,
  slot: WidgetSlot,
  order: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  hidden: Schema.Boolean,
});
export interface WidgetAttachment extends Schema.Schema.Type<typeof WidgetAttachment> {}

export const widgetAttachmentContracts = [
  {
    command: "widgets.attach",
    summary: "Attach an existing widget instance to chat surfaces",
    inputSchema: Schema.Struct({
      id: WidgetAttachment.fields.id,
      lineageId: ArtifactLineageId,
      target: WidgetTarget,
      slot: WidgetSlot,
      order: Schema.optionalKey(WidgetAttachment.fields.order),
    }),
  },
  {
    command: "widgets.detach",
    summary: "Remove a widget attachment without deleting its saved state or background jobs",
    inputSchema: Schema.Struct({ id: WidgetAttachment.fields.id }),
  },
  {
    command: "widgets.attachments",
    summary: "List widget attachments",
    inputSchema: Schema.Struct({}),
  },
] as const;

export function widgetAppliesTo(
  target: WidgetTarget,
  sessionId: string,
  kind: "project-chat" | "project-session" | "cake-chat" | "automation-session",
) {
  switch (target.kind) {
    case "global":
      return true;
    case "project-chats":
      return kind === "project-chat";
    case "project-sessions":
      return kind === "project-session";
    case "session":
      return target.sessionId === sessionId;
  }
}

/** Widgets may use Cake tools, but cannot grant capabilities or change their own applicability. */
export function assertWidgetCommand(command: string) {
  if (
    widgetAttachmentContracts.some(
      (contract) => contract.command === command && command !== "widgets.attachments",
    ) ||
    [
      "settings.widgets.install",
      "settings.widgets.remove",
      "settings.mcp.update",
      "settings.mcp.native",
      "settings.providers.login",
      "settings.providers.logout",
      "settings.desktop.sharing",
    ].includes(command)
  )
    throw new Error(
      `Widgets cannot invoke ${command}; attachment and permission management belong to users and agents`,
    );
}
