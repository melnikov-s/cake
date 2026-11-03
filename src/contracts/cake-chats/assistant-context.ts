import { Schema } from "effect";

const path = Schema.NonEmptyString.check(Schema.isMaxLength(4_096));

/** Invoking surface facts, not the companion's own project or storage location. */
export const AssistantContext = Schema.Struct({
  sessionId: Schema.NonEmptyString.check(Schema.isMaxLength(256)),
  title: Schema.String.check(Schema.isMaxLength(512)),
  kind: Schema.Literals(["project-session", "project-chat", "cake-chat"]),
  mode: Schema.NonEmptyString.check(Schema.isMaxLength(80)),
  project: Schema.NullOr(
    Schema.Struct({
      path,
      name: Schema.String,
    }),
  ),
  workingDirectory: Schema.NullOr(path),
  worktree: Schema.NullOr(
    Schema.Struct({
      path,
      checkoutPath: path,
      branch: Schema.NonEmptyString.check(Schema.isMaxLength(512)),
    }),
  ),
});
export interface AssistantContext extends Schema.Schema.Type<typeof AssistantContext> {}

export const sameAssistantContext = (a: AssistantContext | null, b: AssistantContext | null) =>
  a?.sessionId === b?.sessionId &&
  a?.title === b?.title &&
  a?.kind === b?.kind &&
  a?.mode === b?.mode &&
  a?.project?.path === b?.project?.path &&
  a?.project?.name === b?.project?.name &&
  a?.workingDirectory === b?.workingDirectory &&
  a?.worktree?.path === b?.worktree?.path &&
  a?.worktree?.checkoutPath === b?.worktree?.checkoutPath &&
  a?.worktree?.branch === b?.worktree?.branch;
