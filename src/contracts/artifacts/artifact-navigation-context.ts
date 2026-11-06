import { Schema } from "effect";

/** Disposable navigation facts for one renderer window, never an invocation's caller. */
export const ArtifactNavigationContext = Schema.Struct({
  windowId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  project: Schema.NullOr(Schema.Struct({ path: Schema.String, name: Schema.String })),
  session: Schema.NullOr(
    Schema.Struct({
      sessionId: Schema.String,
      kind: Schema.Literals(["project-session", "project-chat", "cake-chat", "automation-session"]),
    }),
  ),
});
export interface ArtifactNavigationContext extends Schema.Schema.Type<
  typeof ArtifactNavigationContext
> {}
