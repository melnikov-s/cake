import { it } from "@effect/vitest";
import { Effect, Exit, Layer } from "effect";
import { describe, expect } from "vitest";
import { defaultApplicationState } from "../../../src/contracts/application/application-data";
import { loadMcpSettings, mutateMcpSettings } from "../../../src/domain/mcp/mcp-settings";
import { McpSettings, makeMcpSettingsLayer } from "../../../src/services/pi/McpSettings";
import { CakeSessionRuntimes, PiSessionError } from "../../../src/services/pi/CakeSessionRuntimes";
import { ProjectAccess } from "../../../src/services/projects/ProjectAccess";
import { ApplicationState } from "../../../src/services/storage/ApplicationState";

function fixture(trusted = true, allowed = true, reloadFails = false) {
  const data = new Map<string, string>();
  const reads: string[] = [];
  const reloads: string[] = [];
  const layer = Layer.mergeAll(
    makeMcpSettingsLayer("/backend/agent", {
      read: (path) => {
        reads.push(path);
        return data.get(path) ?? "";
      },
      write: (path, content) => {
        data.set(path, content);
      },
    }),
    Layer.mock(ProjectAccess, { isAllowed: () => Effect.succeed(allowed) }),
    Layer.mock(ApplicationState, {
      snapshot: () => ({
        ...defaultApplicationState(),
        trustedProjectPaths: trusted ? ["/project"] : [],
      }),
    }),
    Layer.mock(CakeSessionRuntimes, {
      reloadAll: () =>
        reloadFails
          ? Effect.fail(new PiSessionError({ operation: "reload", message: "controlled failure" }))
          : Effect.sync(() => {
              reloads.push("all");
            }),
      reloadWorkingDirectory: (path) =>
        Effect.sync(() => {
          reloads.push(path);
        }),
    }),
  );
  return { data, reads, reloads, layer };
}
describe("Backend native MCP configuration", () => {
  it.effect(
    "uses backend-derived native paths, authorizes trust before reading and reloads the selected scope after commit",
    () => {
      const f = fixture();
      return Effect.gen(function* () {
        const global = yield* loadMcpSettings({});
        yield* mutateMcpSettings({
          revision: global.revision,
          name: "docs",
          action: "save",
          config: {
            url: "https://example.com/mcp",
            headers: { Authorization: "${TOKEN}" },
            oauth: {
              callbackPort: 8765,
              callbackUrl: "http://localhost:8765/callback",
              authServerMetadataUrl: "https://auth.example.com/metadata",
            },
            toolExposure: { "delete_*": "hidden" },
          },
        });
        const project = yield* loadMcpSettings({ projectPath: "/project" });
        yield* mutateMcpSettings({
          projectPath: "/project",
          revision: project.revision,
          name: "docs",
          action: "save",
          config: { command: "server", enabled: false },
        });
        expect(f.reloads).toEqual(["all", "/project"]);
        const combined = yield* loadMcpSettings({ projectPath: "/project" });
        expect(combined.entries.map((entry) => [entry.scope, entry.overridden])).toEqual([
          ["backend", true],
          ["project", false],
        ]);
        yield* mutateMcpSettings({
          projectPath: "/project",
          revision: combined.revision,
          name: "docs",
          action: "remove",
        });
        expect((yield* loadMcpSettings({ projectPath: "/project" })).entries).toHaveLength(1);
        expect(
          f.reads.every((path) =>
            ["/backend/agent/mcp.json", "/project/.pi/mcp.json"].includes(path),
          ),
        ).toBe(true);
      }).pipe(Effect.provide(f.layer));
    },
  );
  it.effect("rejects untrusted and unauthorized scope before filesystem access", () =>
    Effect.gen(function* () {
      for (const [trusted, allowed] of [
        [false, true],
        [true, false],
      ]) {
        const f = fixture(trusted, allowed);
        const result = yield* Effect.exit(
          loadMcpSettings({ projectPath: "/project" }).pipe(Effect.provide(f.layer)),
        );
        expect(Exit.isFailure(result)).toBe(true);
        expect(f.reads).toEqual([]);
      }
    }),
  );
  it.effect(
    "rejects cross-scope namespace collisions, project provider auth and invalid OAuth without writing",
    () => {
      const f = fixture();
      f.data.set(
        "/backend/agent/mcp.json",
        JSON.stringify({ mcpServers: { "dev-tools": { url: "https://example.com/mcp" } } }),
      );
      return Effect.gen(function* () {
        const initial = yield* loadMcpSettings({ projectPath: "/project" });
        for (const [name, config] of [
          ["dev_tools", { command: "server" }],
          ["unsafe", { url: "https://example.com/mcp", auth: { provider: "anthropic" } }],
          [
            "unsafe",
            {
              url: "https://example.com/mcp",
              oauth: { callbackUrl: "https://not-loopback.example/callback" },
            },
          ],
          [
            "unsafe",
            {
              url: "https://example.com/mcp",
              oauth: { callbackUrl: "http://localhost:123/callback", callbackPort: 456 },
            },
          ],
          ["unsafe", { type: "sse", url: "https://example.com/sse" }],
        ] as const) {
          expect(
            Exit.isFailure(
              yield* Effect.exit(
                mutateMcpSettings({
                  projectPath: "/project",
                  revision: initial.revision,
                  name,
                  action: "save",
                  config,
                }),
              ),
            ),
          ).toBe(true);
        }
        expect(f.data.has("/project/.pi/mcp.json")).toBe(false);
        expect(f.reloads).toEqual([]);
      }).pipe(Effect.provide(f.layer));
    },
  );
  it.effect(
    "masks argument credentials and credential-bearing URLs, and roundtrips positional placeholders",
    () => {
      const f = fixture();
      f.data.set(
        "/backend/agent/mcp.json",
        JSON.stringify({
          mcpServers: {
            local: { command: "server", args: ["--api-key", "argument-secret"] },
            http: { url: "https://user:password@example.com/mcp?token=url-secret" },
          },
        }),
      );
      return Effect.gen(function* () {
        const settings = yield* McpSettings;
        const initial = yield* settings.load({});
        expect(JSON.stringify(initial)).not.toContain("argument-secret");
        expect(JSON.stringify(initial)).not.toContain("url-secret");
        const local = initial.entries.find((entry) => entry.name === "local");
        if (!local) throw new Error("Missing local entry");
        yield* settings.mutate({
          revision: initial.revision,
          name: "local",
          action: "save",
          config: { ...local.config, description: "Edited safely" },
        });
        const revealed = yield* settings.load({ revealSecrets: true });
        expect(revealed.entries.find((entry) => entry.name === "local")?.config.args).toEqual([
          "--api-key",
          "argument-secret",
        ]);
      }).pipe(Effect.provide(f.layer));
    },
  );
  it.effect(
    "serializes concurrent saves and rejects stale revisions instead of losing another window’s edit",
    () => {
      const f = fixture();
      return Effect.gen(function* () {
        const settings = yield* McpSettings;
        const initial = yield* settings.load({});
        const outcomes = yield* Effect.forEach(
          ["first", "second"],
          (name) =>
            Effect.exit(
              settings.mutate({
                revision: initial.revision,
                name,
                action: "save",
                config: { command: name },
              }),
            ),
          { concurrency: "unbounded" },
        );
        expect(outcomes.filter(Exit.isSuccess)).toHaveLength(1);
        expect(outcomes.filter(Exit.isFailure)).toHaveLength(1);
        expect((yield* settings.load({})).entries).toHaveLength(1);
      }).pipe(Effect.provide(f.layer));
    },
  );
  it.effect("reports a saved configuration honestly when existing-session reload fails", () => {
    const f = fixture(true, true, true);
    return Effect.gen(function* () {
      const initial = yield* loadMcpSettings({});
      const error = yield* Effect.flip(
        mutateMcpSettings({
          revision: initial.revision,
          name: "saved",
          action: "save",
          config: { command: "server", enabled: false },
        }),
      );
      expect(error.message).toContain("Configuration was saved, but Pi reload failed");
      expect((yield* loadMcpSettings({})).entries[0]?.name).toBe("saved");
    }).pipe(Effect.provide(f.layer));
  });
  it.effect("reports malformed JSON as a typed error without replacing the native file", () => {
    const f = fixture();
    f.data.set("/backend/agent/mcp.json", "{broken");
    return Effect.gen(function* () {
      const result = yield* Effect.exit(loadMcpSettings({}));
      expect(Exit.isFailure(result)).toBe(true);
      expect(f.data.get("/backend/agent/mcp.json")).toBe("{broken");
    }).pipe(Effect.provide(f.layer));
  });
});
