import { Schema } from "effect";

const packageNamePattern = "(?:@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*";
const reservedReact = /^(?:react|react-dom)(?:@|$)/;

/** Registry packages only: no paths, URLs, aliases, flags or replacement React runtimes. */
export const WidgetPackageName = Schema.String.check(
  Schema.isMaxLength(214),
  Schema.isPattern(new RegExp(`^${packageNamePattern}$`)),
  Schema.makeFilter((name) => !reservedReact.test(name), {
    message: "React and ReactDOM are supplied by Cake and cannot be managed as widget packages.",
  }),
);
export const WidgetPackageSpecifier = Schema.String.check(
  Schema.isMaxLength(512),
  Schema.isPattern(new RegExp(`^${packageNamePattern}(?:@[a-zA-Z0-9*^~<>=|.+ -]+)?$`)),
  Schema.makeFilter((specifier) => !reservedReact.test(specifier), {
    message: "React and ReactDOM are supplied by Cake and cannot be managed as widget packages.",
  }),
);
export const WidgetPackageSnapshot = Schema.Struct({
  directory: Schema.String,
  packages: Schema.Array(Schema.Struct({ name: WidgetPackageName, version: Schema.String })),
});
export interface WidgetPackageSnapshot extends Schema.Schema.Type<typeof WidgetPackageSnapshot> {}

export const WidgetPackageInstall = Schema.Struct({
  specifier: WidgetPackageSpecifier,
  userApproved: Schema.Literal(true),
});
export const WidgetPackageRemove = Schema.Struct({ name: WidgetPackageName });

export class WidgetPackageError extends Schema.TaggedError<WidgetPackageError>()(
  "WidgetPackageError",
  { message: Schema.String },
) {}
