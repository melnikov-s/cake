import { afterEach, expect, it } from "vitest";
import { Context, Effect, Layer, Schema } from "effect";
import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { mkdtemp, rm, lstat, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { McpClient, StreamableHttpTransport } from "@earendil-works/pi-mcp";
import * as mcp from "../../src/domain/mcp/localMcp";
import { LocalMcpServer, open } from "../../src/services/local-mcp/LocalMcpServer";
import {
  LocalMcpSettings,
  makeLocalMcpSettingsLive,
} from "../../src/services/storage/LocalMcpSettings";
import { localMcpFixture, localMcpTarget } from "../app/helpers/localMcpHarness";
import type { LocalMcpConfiguration } from "../../src/contracts/mcp/local-mcp";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
const fixture = Effect.fn("LocalMcp.test.fixture")(function* () {
  const path = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "cake-mcp-")));
  directories.push(path);
  const f = yield* localMcpFixture();
  const services = yield* Layer.build(
    Layer.merge(
      LocalMcpServer.layer,
      makeLocalMcpSettingsLive(path).pipe(
        Layer.provide(Layer.merge(NodeFileSystem.layer, NodePath.layer)),
      ),
    ),
  );
  const context = Context.merge(f.context, services);
  yield* mcp.initialize().pipe(Effect.provide(context));
  return { ...f, path, context };
});
function client(url: string, token: string) {
  const transport = new StreamableHttpTransport({
    url,
    headers: { Authorization: `Bearer ${token}` },
    openGetStream: false,
  });
  return {
    transport,
    client: new McpClient({ name: "cake-test", version: "1", requestTimeoutMs: 5000 }),
  };
}
const call = (client: McpClient, command: string, input: Record<string, unknown> = {}) =>
  client.callTool("cake", { command, input });
const content = (value: { content: readonly unknown[] }) => {
  const block = Schema.decodeUnknownSync(
    Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }),
  )(value.content[0]);
  return JSON.parse(block.text);
};
const configuration: LocalMcpConfiguration = {
  enabled: true,
  port: 0,
  projects: ["/project"],
  scopes: ["read", "launch", "send", "todos.write"],
};

it("serves real Cake operations directly over authenticated Effect HTTP MCP", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture();
        const snapshot = yield* mcp.configure(configuration).pipe(Effect.provide(f.context));
        const document = yield* Context.get(f.context, LocalMcpSettings).load();
        const url = Schema.decodeUnknownSync(Schema.String)(snapshot.runtime.url);
        expect(
          JSON.parse(Schema.decodeUnknownSync(Schema.String)(snapshot.clientConfiguration)),
        ).toMatchObject({
          mcpServers: {
            cake: { type: "http", url, headers: { Authorization: `Bearer ${document.token}` } },
          },
        });
        yield* Effect.promise(async () => {
          const c = client(url, document.token);
          try {
            expect((await c.client.connect(c.transport)).serverInfo.name).toBe("cake-local");
            await c.client.ping();
            const tools = await c.client.listTools();
            expect(tools.map((tool) => tool.name)).toEqual(["cake"]);
            expect(content(await c.client.callTool("cake", {})).commands).toEqual(
              expect.arrayContaining([expect.objectContaining({ command: "sessions.create" })]),
            );
            expect(content(await call(c.client, "sessions.create.help")).inputSchema).toMatchObject(
              {
                type: "object",
                required: expect.arrayContaining(["projectPath", "initialPrompt", "name"]),
              },
            );
            await expect(c.client.callTool("sessions.list", {})).rejects.toThrow("not found");
            expect(content(await call(c.client, "projects.list"))).toMatchObject({
              projects: [{ path: "/project" }],
            });
            expect(
              content(
                await call(c.client, "sessions.create", {
                  projectPath: "/project",
                  name: "Task",
                  initialPrompt: "Work",
                }),
              ),
            ).toMatchObject({ status: "started", sessionId: expect.any(String) });
            expect(f.prompts.some((text) => text.includes("Work"))).toBe(true);
            expect(
              content(
                await call(c.client, "sessions.send", {
                  projectPath: "/project",
                  sessionId: localMcpTarget,
                  text: "Continue",
                }),
              ),
            ).toMatchObject({ command: "sessions.send" });
            const created = content(
              await call(c.client, "todos.create", {
                projectPath: "/project",
                title: "Task",
                description: "Work started",
              }),
            );
            const { id, revision } = created.result;
            expect(
              content(await call(c.client, "todos.read", { projectPath: "/project", id })),
            ).toMatchObject({ result: { title: "Task", state: "open" } });
            expect(
              content(
                await call(c.client, "todos.update", {
                  projectPath: "/project",
                  id,
                  expectedRevision: revision,
                  state: "done",
                }),
              ),
            ).toMatchObject({ result: { revision: revision + 1, committed: true } });
            expect(
              (
                await call(c.client, "todos.update", {
                  projectPath: "/project",
                  id,
                  expectedRevision: revision,
                  title: "Stale",
                })
              ).isError,
            ).toBe(true);
            expect(
              (
                await call(c.client, "sessions.create", {
                  projectPath: "/project",
                  name: "Task",
                  initialPrompt: "Work",
                  approved: true,
                })
              ).isError,
            ).toBe(true);
            expect(
              content(await call(c.client, "projects.info", { projectPath: "/other" })),
            ).toMatchObject({ code: "denied" });
            expect(content(await call(c.client, "sessions.cake", {}))).toMatchObject({
              code: "unsupported",
            });
          } finally {
            await c.client.close();
          }
        });
      }),
    ),
  );
});

it("defaults off and persists private settings and token across server restarts", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture();
        const initial = yield* mcp.get().pipe(Effect.provide(f.context));
        expect(initial.configuration).toMatchObject({
          enabled: false,
          projects: [],
          scopes: ["read"],
        });
        expect(initial.runtime).toEqual({ status: "disabled" });
        expect(initial.clientConfiguration).toBeUndefined();
        const stored = yield* Context.get(f.context, LocalMcpSettings).load();
        expect(
          (yield* Effect.promise(() => lstat(join(f.path, "mcp-server.json")))).mode & 0o777,
        ).toBe(0o600);
        yield* mcp.configure(configuration).pipe(Effect.provide(f.context));
        yield* Context.get(f.context, LocalMcpServer).configure(undefined);
        yield* mcp.initialize().pipe(Effect.provide(f.context));
        const restarted = yield* mcp.get().pipe(Effect.provide(f.context));
        expect(restarted.runtime.status).toBe("serving");
        expect((yield* Context.get(f.context, LocalMcpSettings).load()).token).toBe(stored.token);
        expect(
          JSON.parse(
            yield* Effect.promise(() => readFile(join(f.path, "mcp-server.json"), "utf8")),
          ),
        ).toMatchObject({ configuration });
        const url = Schema.decodeUnknownSync(Schema.String)(restarted.runtime.url);
        yield* mcp.configure({ ...configuration, enabled: false }).pipe(Effect.provide(f.context));
        yield* mcp.initialize().pipe(Effect.provide(f.context));
        expect((yield* mcp.get().pipe(Effect.provide(f.context))).runtime.status).toBe("disabled");
        yield* Effect.promise(() => expect(fetch(url)).rejects.toThrow());
      }),
    ),
  );
});

it("rejects unauthenticated, wrong-token, foreign Host and browser-origin access", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture();
        const snapshot = yield* mcp.configure(configuration).pipe(Effect.provide(f.context));
        const url = Schema.decodeUnknownSync(Schema.String)(snapshot.runtime.url);
        const { token } = yield* Context.get(f.context, LocalMcpSettings).load();
        yield* Effect.promise(async () => {
          const unauthorized: Record<string, string>[] = [
            {},
            { Authorization: "Bearer incorrect" },
          ];
          for (const headers of unauthorized)
            expect((await fetch(url, { headers })).status).toBe(401);
          expect(
            await new Promise<number | undefined>((resolve, reject) => {
              const req = request(
                url,
                { headers: { Host: "evil.example", Authorization: `Bearer ${token}` } },
                (response) => {
                  response.resume();
                  resolve(response.statusCode);
                },
              );
              req.on("error", reject);
              req.end();
            }),
          ).toBe(403);
          for (const origin of ["http://evil.example", new URL(url).origin])
            expect(
              (await fetch(url, { headers: { Origin: origin, Authorization: `Bearer ${token}` } }))
                .status,
            ).toBe(403);
          expect((await fetch(url, { headers: { Authorization: `Bearer ${token}` } })).status).toBe(
            405,
          );
        });
        const rotated = yield* mcp.rotateToken().pipe(Effect.provide(f.context));
        const newUrl = Schema.decodeUnknownSync(Schema.String)(rotated.runtime.url);
        const updated = yield* Context.get(f.context, LocalMcpSettings).load();
        expect(updated.token).not.toBe(token);
        yield* Effect.promise(async () => {
          expect(
            (await fetch(newUrl, { headers: { Authorization: `Bearer ${token}` } })).status,
          ).toBe(401);
          const c = client(newUrl, updated.token);
          try {
            await c.client.connect(c.transport);
            await c.client.ping();
          } finally {
            await c.client.close();
          }
        });
      }),
    ),
  );
});

it("enforces read-only scopes on direct calls and applies permission changes live", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture();
        for (const scopes of [["read"] as const, [] as const]) {
          const snapshot = yield* mcp
            .configure({ ...configuration, scopes })
            .pipe(Effect.provide(f.context));
          const { token } = yield* Context.get(f.context, LocalMcpSettings).load();
          const url = Schema.decodeUnknownSync(Schema.String)(snapshot.runtime.url);
          yield* Effect.promise(async () => {
            const c = client(url, token);
            try {
              await c.client.connect(c.transport);
              expect(
                (await c.client.listTools()).every((tool) => tool.annotations?.readOnlyHint),
              ).toBe(true);
              expect(
                content(
                  await call(c.client, "sessions.create", {
                    projectPath: "/project",
                    name: "Task",
                    initialPrompt: "Work",
                  }),
                ),
              ).toMatchObject({ code: "denied" });
              expect(content(await call(c.client, "sessions.create.help"))).toMatchObject({
                code: "denied",
              });
              const discovery = content(await c.client.callTool("cake", {}));
              if (scopes.length === 0) expect(discovery.commands).toEqual([]);
              else
                expect(
                  discovery.commands.every(
                    (command: { command: string }) =>
                      ![
                        "sessions.create",
                        "sessions.send",
                        "todos.create",
                        "todos.update",
                      ].includes(command.command),
                  ),
                ).toBe(true);
            } finally {
              await c.client.close();
            }
          });
        }
      }),
    ),
  );
});

it("interrupts unfinished tool work when the server is disabled", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture();
        const { promise: entered, resolve: called } = Promise.withResolvers<void>();
        const { promise: cancelled, resolve: aborted } = Promise.withResolvers<void>();
        const server = Context.get(f.context, LocalMcpServer);
        const runtime = yield* server.configure({
          port: 0,
          token: "test-token",
          endpoint: {
            tools: [
              {
                name: "cake",
                description: "Test shutdown",
                inputSchema: { type: "object" },
                annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
              },
            ],
            call: async (_name, _input, signal) => {
              called();
              await new Promise<void>((resolve) =>
                signal.addEventListener(
                  "abort",
                  () => {
                    aborted();
                    resolve();
                  },
                  { once: true },
                ),
              );
              return {};
            },
          },
        });
        const c = client(Schema.decodeUnknownSync(Schema.String)(runtime.url), "test-token");
        yield* Effect.promise(() => c.client.connect(c.transport));
        const pending = c.client.callTool("cake", {}).catch(() => undefined);
        yield* Effect.promise(() => entered);
        yield* server.configure(undefined);
        yield* Effect.promise(async () => {
          await cancelled;
          await pending;
          await c.client.close();
        });
      }),
    ),
  );
});

it("rejects invalid grants and reports an occupied port without crashing Cake", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture();
        for (const projects of [[], ["relative"], ["/other"]]) {
          expect(
            yield* mcp
              .configure({ ...configuration, projects })
              .pipe(Effect.result, Effect.provide(f.context)),
          ).toMatchObject({ _tag: "Failure", failure: { code: "invalid_input" } });
        }
        const occupied = yield* open(0, "test-token", { tools: [], call: async () => ({}) });
        const port = Number(new URL(occupied).port);
        const snapshot = yield* mcp
          .configure({ ...configuration, port })
          .pipe(Effect.provide(f.context));
        expect(snapshot.runtime).toMatchObject({ status: "error", error: expect.any(String) });
        yield* mcp.configure({ ...configuration, enabled: false }).pipe(Effect.provide(f.context));
        expect((yield* mcp.get().pipe(Effect.provide(f.context))).runtime.status).toBe("disabled");
      }),
    ),
  );
});
