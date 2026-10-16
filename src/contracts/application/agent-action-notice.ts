import { Schema } from "effect";

export const AgentActionNotice = Schema.Struct({
  source: Schema.Struct({
    kind: Schema.Literals(["project-session", "cake-chat"]),
    sessionId: Schema.String,
    title: Schema.String,
    projectName: Schema.optionalKey(Schema.String),
    workingDirectory: Schema.optionalKey(Schema.String),
    projectPath: Schema.optionalKey(Schema.String),
  }),
  message: Schema.String,
  targetSessionId: Schema.optionalKey(Schema.String),
  targetKind: Schema.optionalKey(Schema.Literals(["project-session", "cake-chat"])),
  coalesceKey: Schema.String,
});
export interface AgentActionNotice extends Schema.Schema.Type<typeof AgentActionNotice> {}
