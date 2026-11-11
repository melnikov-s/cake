import { Schema } from "effect";
import { CakeModelSelection } from "../model-presets/cake-model-selection";
import { sessionTargetDescription } from "../project-sessions/session-reference";

export const SessionModelSwitchTarget = Schema.Struct({
  sessionId: Schema.NonEmptyString.annotate({ description: sessionTargetDescription }),
});
export const SessionModelSwitchInput = Schema.Struct({
  ...SessionModelSwitchTarget.fields,
  model: CakeModelSelection,
});

/** Process-local handoff receipt, not a second transcript or a durable task. */
export const SessionModelSwitchStatus = Schema.Struct({
  operationId: Schema.String,
  status: Schema.Literals(["accepted", "switching", "changed", "continued", "failed"]),
  stage: Schema.Literals(["receipt", "stop", "configure", "continue", "complete"]),
  error: Schema.optionalKey(Schema.String),
  turnId: Schema.optionalKey(Schema.String),
});
export interface SessionModelSwitchStatus extends Schema.Schema.Type<
  typeof SessionModelSwitchStatus
> {}

export const SessionModelSwitchOutput = Schema.Struct({
  ok: Schema.Boolean,
  command: Schema.Literals(["sessions.set-model", "sessions.model-switch-status"]),
  sessionId: Schema.String,
  receipt: Schema.NullOr(SessionModelSwitchStatus),
});

export const sessionModelSwitchDefinitions = [
  {
    command: "sessions.set-model",
    topic: "sessions",
    summary: "Set a session model; stop and continue active work",
    guidance: [
      "Explicit sessionId and model required. model is a configured preset name or {provider, modelId, thinkingLevel, fastMode?}; use models.list for choices.",
      "Validates before stopping. Idle: configuration only. Running: stop, join provider/tool cleanup, configure, then admit one Continue. History and queued human input remain intact.",
      "Self-switch returns accepted, not completed, and waits for this tool's receipt before stopping. Read sessions.model-switch-status to verify completion or failure; do not send another Continue.",
      "Project/Automation sessions, discussion Side Chats and permanent Global/Project chats are supported. Companion follows Settings' utility model. Private subagents are single-turn tasks owned by their launcher; cancel/relaunch through their owner instead.",
      "One handoff per target at a time; overlapping requests fail rather than adding duplicate Continue turns. Status is process-local and unavailable after runtime release/restart. A continued receipt proves admission, not a successful model answer.",
    ],
    examples: [{ input: { sessionId: "parent", model: "Fast" } }],
    result:
      "Target identity and a staged handoff receipt. failed includes the failing stage; accepted requires status verification.",
  },
  {
    command: "sessions.model-switch-status",
    topic: "sessions",
    summary: "Read the latest model handoff receipt",
    guidance: [
      "Use the same explicit target as sessions.set-model. null means no retained receipt, not success.",
    ],
    examples: [{ input: { sessionId: "parent" } }],
    result: "Latest process-local staged receipt or null; no work is started.",
  },
] as const;
