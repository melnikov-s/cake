import { Schema } from "effect";

const path = Schema.NonEmptyString.annotate({
  description: "Absolute path on the backend host; never relative to an artifact creator or chat.",
});
export const ArtifactShellInput = Schema.Struct({
  command: Schema.NonEmptyString,
  cwd: path,
  timeoutSeconds: Schema.optionalKey(
    Schema.Number.check(Schema.isFinite(), Schema.isGreaterThan(0)),
  ),
  env: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
});
export interface ArtifactShellInput extends Schema.Schema.Type<typeof ArtifactShellInput> {}

const encoding = Schema.Literals(["utf8", "base64"]);
const operation = <const Name extends string, Input extends Schema.Constraint>(
  name: Name,
  input: Input,
) => Schema.Struct({ name: Schema.Literal(name), arguments: input });

/** Trusted host operations, not a capability allowlist or a gateway to arbitrary Pi tools. */
export const ArtifactHostInvocation = Schema.Union([
  operation("filesystem.read", Schema.Struct({ path, encoding: Schema.optionalKey(encoding) })),
  operation(
    "filesystem.write",
    Schema.Struct({
      path,
      content: Schema.String,
      encoding: Schema.optionalKey(encoding),
    }),
  ),
  operation("filesystem.list", Schema.Struct({ path })),
  operation("shell.run", ArtifactShellInput),
  operation(
    "network.request",
    Schema.Struct({
      url: Schema.String.check(Schema.isPattern(/^https?:\/\//)),
      method: Schema.optionalKey(
        Schema.Literals(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "TRACE"]),
      ),
      headers: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
      body: Schema.optionalKey(Schema.String),
      responseEncoding: Schema.optionalKey(encoding),
    }),
  ),
  operation(
    "chat.prompt",
    Schema.Struct({
      sessionId: Schema.NonEmptyString.annotate({
        description:
          "Explicit destination session identity. No current or creator chat is inferred.",
      }),
      text: Schema.NonEmptyString,
      delivery: Schema.optionalKey(Schema.Literals(["prompt", "steer", "follow-up"])),
    }),
  ),
  operation("commands.list", Schema.Struct({})),
  operation("commands.help", Schema.Struct({ command: Schema.NonEmptyString })),
]);
export type ArtifactHostInvocation = Schema.Schema.Type<typeof ArtifactHostInvocation>;

export const artifactHostCommandDescriptions = {
  "filesystem.read": "Read a backend-host file as UTF-8 text or base64 bytes.",
  "filesystem.write":
    "Write a backend-host file as UTF-8 text or base64 bytes, replacing existing contents. The parent directory must exist.",
  "filesystem.list": "List the immediate names in a backend-host directory.",
  "shell.run":
    "Execute shell syntax on the backend host with required absolute cwd and inherited environment plus env overlays. No session/window needed. Uses the platform command shell (non-login); GUI hosts may need an explicit env.PATH or absolute CLI path. Returns stdout/stderr prefixes (50 KiB each), truncation flags, timedOut and exitCode (null on timeout after process cleanup). Nonzero exits are results; launch/input failures are typed errors. No timeout unless timeoutSeconds is supplied. Direct command cancellation stops the scoped process group; admitted semantic handlers are uninterruptible, so use timeoutSeconds inside artifacts.call.",
  "network.request":
    "Send an HTTP(S) request from the backend host. Returns status, headers and text/base64 body, including non-2xx responses. No automatic retries.",
  "chat.prompt":
    "Submit artifact-attributed input to an explicit existing chat. Returns admission, not the agent's answer. Does not pretend to be user input.",
  "commands.list":
    "Discover canonical backend Cake commands and validated input schemas available to trusted artifacts.",
  "commands.help": "Read the input schema and execution context for one Cake command.",
} satisfies Record<ArtifactHostInvocation["name"], string>;

export const artifactHostCommands: ReadonlySet<string> = new Set(
  ArtifactHostInvocation.members.map((member) => member.fields.name.literal),
);

export class ArtifactCommandError extends Schema.TaggedError<ArtifactCommandError>()(
  "ArtifactCommandError",
  {
    command: Schema.String,
    message: Schema.String,
  },
) {}
