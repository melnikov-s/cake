import { Schema } from "effect";

export const EditorTheme = Schema.Literals(["light", "dark"]);
export const EditorLeaseId = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
const workspacePath = Schema.NonEmptyString.check(Schema.isMaxLength(4_096));
const endpoint = Schema.NonEmptyString.check(Schema.isMaxLength(8_192));
const requestId = Schema.String.check(Schema.isUUID());
export const EditorLease = Schema.Struct({
  id: EditorLeaseId,
  endpoint,
  editorPort: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 })),
  ),
  editorOrigin: Schema.optionalKey(
    Schema.NonEmptyString.check(
      Schema.isMaxLength(2048),
      Schema.makeFilter((value) => {
        try {
          return new URL(value).origin === value && value.startsWith("https://");
        } catch {
          return false;
        }
      }),
    ),
  ),
});
export interface EditorLease extends Schema.Schema.Type<typeof EditorLease> {}
export const AcquireEditor = Schema.Struct({
  requestId,
  workspacePath,
  theme: EditorTheme,
});
export const EditorEndpoint = Schema.Struct({
  workspacePath,
  url: endpoint,
  theme: EditorTheme,
});

const dimension = Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 100_000 }));
export const EditorBounds = Schema.Struct({
  requestId,
  visible: Schema.Boolean,
  x: Schema.Number,
  y: Schema.Number,
  width: dimension,
  height: dimension,
  projectSidebarWidth: dimension,
});
