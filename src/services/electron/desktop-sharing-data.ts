import { Schema } from "effect";

const octet = "(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])";
export const DesktopSharingInput = Schema.Struct({
  enabled: Schema.Boolean,
  bind: Schema.String.check(
    Schema.isPattern(new RegExp(`^${octet}(\\.${octet}){3}$`)),
    Schema.makeFilter((value) => value !== "0.0.0.0", {
      message: "Use a concrete local IPv4 address, not a wildcard bind",
    }),
  ),
  port: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 65535 })),
});
export interface DesktopSharingInput extends Schema.Schema.Type<typeof DesktopSharingInput> {}
export const DesktopSharingState = Schema.Struct({
  status: Schema.Literals(["disabled", "starting", "serving", "stopping", "failed"]),
  bind: Schema.String,
  port: Schema.Number,
  url: Schema.optionalKey(Schema.String),
  editorPort: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 })),
  ),
  error: Schema.optionalKey(Schema.String),
});
export interface DesktopSharingState extends Schema.Schema.Type<typeof DesktopSharingState> {}
export class DesktopSharingError extends Schema.TaggedError<DesktopSharingError>()(
  "DesktopSharingError",
  { message: Schema.String },
) {}
