import { Context, Effect, Layer, Schema, Semaphore } from "effect";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  MCP_STORED_SECRET,
  McpSettingsError,
  type McpSettingsMutation,
  type McpSettingsRead,
  type McpSettingsSnapshot,
} from "./mcp-settings-data";
import { NativeMcpConfig } from "./mcp-config-validation";

interface JsonRecord extends Record<string, Schema.Json> {}
const Document = Schema.Record(Schema.String, Schema.Json);
const Servers = Schema.Record(Schema.String, Document);
export interface McpConfigFiles {
  read(path: string): string;
  write(path: string, content: string): void;
}
const files: McpConfigFiles = {
  read(path) {
    try {
      return readFileSync(path, "utf8");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return "";
      throw error;
    }
  },
  write(path, content) {
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, content, { mode: 0o600 });
      renameSync(temporary, path);
    } finally {
      rmSync(temporary, { force: true });
    }
  },
};
const secretKeys = new Set(["env", "headers", "clientSecret"]);
function redact(config: JsonRecord): JsonRecord {
  return Object.fromEntries(
    Object.entries(config).map(([key, value]) => {
      if (key === "url" && Schema.is(Schema.String)(value) && URL.canParse(value)) {
        const url = new URL(value);
        if (url.username || url.password || url.search) return [key, MCP_STORED_SECRET];
      }
      // Stdio servers commonly receive API keys in arguments; do not guess which ones are secrets.
      if (key === "args" && Schema.is(Schema.Array(Schema.String))(value))
        return [key, value.map(() => MCP_STORED_SECRET)];
      if (secretKeys.has(key)) {
        if (Schema.is(Schema.String)(value)) return [key, MCP_STORED_SECRET];
        if (Schema.is(Document)(value))
          return [
            key,
            Object.fromEntries(Object.keys(value).map((name) => [name, MCP_STORED_SECRET])),
          ];
      }
      if (Schema.is(Document)(value)) return [key, redact(value)];
      return [key, value];
    }),
  );
}
function restore(value: JsonRecord, previous: JsonRecord): JsonRecord {
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => {
      if (entry === MCP_STORED_SECRET) {
        const stored = previous[key];
        if (stored === undefined)
          throw new Error(
            "A stored-value placeholder needs an existing field. Enter a value instead.",
          );
        return [key, stored];
      }
      if (key === "args" && Schema.is(Schema.Array(Schema.String))(entry)) {
        const old = previous[key];
        const stored = Schema.is(Schema.Array(Schema.String))(old) ? old : [];
        return [
          key,
          entry.map((argument, index) => {
            if (argument !== MCP_STORED_SECRET) return argument;
            const argumentValue = stored[index];
            if (argumentValue === undefined)
              throw new Error(
                "An argument placeholder needs an existing argument at the same position.",
              );
            return argumentValue;
          }),
        ];
      }
      if (Schema.is(Document)(entry)) {
        const old = previous[key];
        return [key, restore(entry, Schema.is(Document)(old) ? old : {})];
      }
      return [key, entry];
    }),
  );
}
export class McpSettings extends Context.Service<
  McpSettings,
  {
    readonly load: (scope: McpSettingsRead) => Effect.Effect<McpSettingsSnapshot, McpSettingsError>;
    readonly mutate: (
      input: McpSettingsMutation,
    ) => Effect.Effect<McpSettingsSnapshot, McpSettingsError>;
  }
>()("cake/services/pi/McpSettings") {}

/** Backend-lifetime serialization; files, not this service, are the durable authority. */
export const makeMcpSettingsLayer = (agentDirectory: string, storage: McpConfigFiles = files) =>
  Layer.effect(
    McpSettings,
    Effect.gen(function* () {
      const lock = yield* Semaphore.make(1);
      const read = Effect.fn("McpSettings.read")(function* (scope: McpSettingsRead) {
        const paths = [
          join(agentDirectory, "mcp.json"),
          ...(scope.projectPath ? [join(scope.projectPath, ".pi", "mcp.json")] : []),
        ];
        const contents = yield* Effect.try({
          try: () => paths.map((path) => storage.read(path)),
          catch: () =>
            new McpSettingsError({ message: "Could not read backend MCP configuration." }),
        });
        const documents = yield* Effect.forEach(contents, (text) =>
          Effect.try({
            try: () => (text ? JSON.parse(text) : {}),
            catch: () =>
              new McpSettingsError({
                message: "Invalid MCP JSON. Repair the backend file before editing.",
              }),
          }).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Document)),
            Effect.mapError(
              () =>
                new McpSettingsError({
                  message:
                    "Invalid MCP configuration document. Repair its JSON on the backend before editing.",
                }),
            ),
          ),
        );
        const servers = yield* Effect.forEach(documents, (document) =>
          Schema.decodeUnknownEffect(Servers)(document.mcpServers ?? {}).pipe(
            Effect.mapError(
              () =>
                new McpSettingsError({
                  message: "mcpServers must map server names to configuration objects.",
                }),
            ),
          ),
        );
        const revision = createHash("sha256").update(JSON.stringify(contents)).digest("hex");
        const projectNames = new Set(Object.keys(servers[1] ?? {}));
        const entries = servers.flatMap((group, index) =>
          Object.entries(group).map(([name, config]) => ({
            name,
            config: scope.revealSecrets ? config : redact(config),
            scope: index === 0 ? ("backend" as const) : ("project" as const),
            source: paths[index] ?? "",
            overridden: index === 0 && projectNames.has(name),
          })),
        );
        return {
          documents,
          servers,
          paths,
          snapshot: {
            scope: scope.projectPath ? { projectPath: scope.projectPath } : {},
            revision,
            entries,
          },
        };
      });
      const load = Effect.fn("McpSettings.load")((scope: McpSettingsRead) =>
        lock.withPermits(1)(Effect.map(read(scope), (value) => value.snapshot)),
      );
      const mutate = Effect.fn("McpSettings.mutate")((input: McpSettingsMutation) =>
        lock.withPermits(1)(
          Effect.gen(function* () {
            const current = yield* read(input);
            if (current.snapshot.revision !== input.revision)
              return yield* new McpSettingsError({
                message: "MCP configuration changed. Refresh before saving again.",
              });
            const index = input.projectPath ? 1 : 0;
            const storedDocument = current.documents[index];
            const storedServers = current.servers[index];
            const document = storedDocument ? { ...storedDocument } : undefined;
            const servers = storedServers ? { ...storedServers } : undefined;
            const path = current.paths[index];
            if (!document || !servers || !path)
              return yield* new McpSettingsError({ message: "Missing configuration scope." });
            if (input.action === "remove") delete servers[input.name];
            else {
              const previous = servers[input.name];
              let config: JsonRecord;
              if (input.action === "save") {
                if (!input.config)
                  return yield* new McpSettingsError({
                    message: "A server configuration is required.",
                  });
                config = yield* Effect.try({
                  try: () => restore(input.config ?? {}, previous ?? {}),
                  catch: (error) =>
                    new McpSettingsError({
                      message: error instanceof Error ? error.message : "Invalid stored value.",
                    }),
                });
              } else {
                if (!previous)
                  return yield* new McpSettingsError({
                    message: "Refresh to edit this configuration in its defining scope.",
                  });
                config = { ...previous };
                config.enabled = input.action === "enable";
              }
              if (config.url !== undefined && config.command !== undefined)
                return yield* new McpSettingsError({
                  message: "Choose either a command or an HTTP URL, not both.",
                });
              if (input.projectPath && config.auth !== undefined)
                return yield* new McpSettingsError({
                  message:
                    "Provider credentials (auth) are not permitted in Project MCP configuration.",
                });
              yield* Schema.decodeUnknownEffect(NativeMcpConfig)(config).pipe(
                Effect.mapError(
                  () =>
                    new McpSettingsError({
                      message:
                        "Invalid MCP config: check transport, command/URL, args/env/headers, exposure, positive timeout and OAuth loopback callback/port fields.",
                    }),
                ),
              );
              if (
                current.servers
                  .flatMap((group) => Object.keys(group))
                  .some(
                    (name) =>
                      name !== input.name &&
                      name.replaceAll("-", "_") === input.name.replaceAll("-", "_"),
                  )
              )
                return yield* new McpSettingsError({
                  message: "Server names differing only by hyphens and underscores collide in Pi.",
                });
              servers[input.name] = config;
            }
            document.mcpServers = servers;
            yield* Effect.try({
              try: () => storage.write(path, `${JSON.stringify(document, null, 2)}\n`),
              catch: () =>
                new McpSettingsError({
                  message: "Could not save MCP configuration on the backend.",
                }),
            });
            return (yield* read(input)).snapshot;
          }),
        ),
      );
      return McpSettings.of({ load, mutate });
    }),
  );
