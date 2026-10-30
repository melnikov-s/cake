import { afterEach, expect, it } from "vitest";
import { Context, Effect, Layer, Schema } from "effect";
import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { mkdtemp, rm, lstat, readFile, writeFile } from "node:fs/promises";
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
import { CakeSessionRuntimes } from "../../src/services/pi/CakeSessionRuntimes";
import { CAKE_CHAT_SESSION_ID } from "../../src/contracts/cake-chats/cake-chat-identity";
import { projectChatSessionId } from "../../src/domain/cake-chats/cakeChatLocations";
import { localMcpFixture, localMcpTarget } from "../app/helpers/localMcpHarness";
import type { LocalMcpConfiguration } from "../../src/contracts/mcp/local-mcp";
import type { CakeOperationInvocation } from "../../src/contracts/agent/cake-operation";

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
const content = (value: { content: readonly unknown[] }) =>
  Schema.decodeUnknownSync(Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }))(
    value.content[0],
  ).text;
const configuration: LocalMcpConfiguration = { enabled: true, port: 0 };
const emptyResult = (): CakeOperationInvocation => ({
  text: "{}",
  content: [{ type: "text", text: "{}" }],
  details: {},
  structuredContent: {},
});

it("exposes the existing Cake Chat registry unchanged through one authenticated cake tool", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.state.transact((state) =>
          Effect.succeed({
            ...state,
            projects: [
              ...state.projects,
              {
                path: "/other",
                name: "Other",
                addedAt: "2026-01-01T00:00:00.000Z",
                lastOpenedAt: "2026-01-01T00:00:00.000Z",
              },
            ],
          }),
        );
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
        const root = yield* Context.get(f.context, CakeSessionRuntimes).acquireSession(
          CAKE_CHAT_SESSION_ID,
        );
        const help = yield* root.callCakeTool("help", {});
        const nestedHelp = yield* root.callCakeTool("sessions.cake.help", {});
        yield* Effect.promise(async () => {
          const c = client(url, document.token);
          try {
            expect((await c.client.connect(c.transport)).serverInfo.name).toBe("cake-local");
            await c.client.ping();
            const tools = await c.client.listTools();
            expect(tools.map((tool) => tool.name)).toEqual(["cake"]);
            expect(tools[0]?.annotations).toMatchObject({
              readOnlyHint: false,
              destructiveHint: true,
              openWorldHint: true,
            });
            expect((await c.client.callTool("cake", {})).content).toEqual(help.content);
            expect((await call(c.client, "sessions.cake.help")).content).toEqual(
              nestedHelp.content,
            );
            expect(content(await call(c.client, "projects.rename.help"))).toContain(
              "projects.rename —",
            );
            expect(content(await call(c.client, "projects.list"))).toContain("/other");
            expect(
              content(
                await call(c.client, "projects.rename", {
                  path: "/other",
                  name: "Renamed over MCP",
                }),
              ),
            ).toContain("Renamed over MCP");
            expect(
              f.state.snapshot().projects.find((project) => project.path === "/other")?.name,
            ).toBe("Renamed over MCP");
            expect(
              content(
                await call(c.client, "sessions.create", {
                  workspacePath: "/project",
                  name: "Task",
                  initialPrompt: "Work",
                }),
              ),
            ).toContain('"started"');
            expect(f.prompts.some((text) => text.includes("Work"))).toBe(true);
            expect(
              content(
                await call(c.client, "sessions.send", {
                  sessionId: localMcpTarget,
                  text: "Continue",
                }),
              ),
            ).toContain("sessions.send");
            expect(
              content(
                await call(c.client, "sessions.cake", {
                  sessionId: projectChatSessionId("/project"),
                  command: "todos.create",
                  input: {
                    title: "Full registry",
                    description: "Created through the normal session gateway",
                  },
                }),
              ),
            ).toContain("committed");
            expect(
              f.state
                .snapshot()
                .projects.find((project) => project.path === "/project")
                ?.todos?.items.some((todo) => todo.title === "Full registry"),
            ).toBe(true);
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
        expect((yield* mcp.get().pipe(Effect.provide(f.context))).runtime).toEqual({
          status: "disabled",
        });
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
        ).toMatchObject({ version: 2, configuration });
        const url = Schema.decodeUnknownSync(Schema.String)(restarted.runtime.url);
        yield* mcp.configure({ ...configuration, enabled: false }).pipe(Effect.provide(f.context));
        yield* mcp.initialize().pipe(Effect.provide(f.context));
        expect((yield* mcp.get().pipe(Effect.provide(f.context))).runtime.status).toBe("disabled");
        yield* Effect.promise(() => expect(fetch(url)).rejects.toThrow());
      }),
    ),
  );
});

it("migrates saved scoped access without silently promoting it to full control", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture();
        const stored = yield* Context.get(f.context, LocalMcpSettings).load();
        yield* Effect.promise(() =>
          writeFile(
            join(f.path, "mcp-server.json"),
            JSON.stringify({
              version: 1,
              token: stored.token,
              configuration: {
                enabled: true,
                port: 4318,
                projects: ["/project"],
                scopes: ["read"],
              },
            }),
          ),
        );
        yield* mcp.initialize().pipe(Effect.provide(f.context));
        const migrated = yield* Context.get(f.context, LocalMcpSettings).load();
        expect(migrated).toEqual({
          version: 2,
          token: stored.token,
          configuration: { enabled: false, port: 4318 },
        });
        expect((yield* mcp.get().pipe(Effect.provide(f.context))).runtime.status).toBe("disabled");
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

it("preserves native image content and structured results", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const runtime = yield* open(0, "test-token", {
          tools: [
            {
              name: "cake",
              description: "Image transport test",
              inputSchema: { type: "object" },
              annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
            },
          ],
          call: async () => ({
            ...emptyResult(),
            content: [
              { type: "text", text: "Screenshot" },
              { type: "image", mimeType: "image/png", data: "aW1hZ2U=" },
            ],
            structuredContent: { result: "metadata" },
          }),
        });
        yield* Effect.promise(async () => {
          const c = client(runtime, "test-token");
          try {
            await c.client.connect(c.transport);
            const result = await c.client.callTool("cake", {});
            expect(result.content).toEqual([
              { type: "text", text: "Screenshot" },
              { type: "image", mimeType: "image/png", data: "aW1hZ2U=" },
            ]);
            expect(result.structuredContent).toEqual({ result: "metadata" });
          } finally {
            await c.client.close();
          }
        });
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
                annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
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
              return emptyResult();
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

it("reports an occupied port without crashing Cake", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture();
        const occupied = yield* open(0, "test-token", {
          tools: [],
          call: async () => emptyResult(),
        });
        const snapshot = yield* mcp
          .configure({ ...configuration, port: Number(new URL(occupied).port) })
          .pipe(Effect.provide(f.context));
        expect(snapshot.runtime).toMatchObject({ status: "error", error: expect.any(String) });
        yield* mcp.configure({ ...configuration, enabled: false }).pipe(Effect.provide(f.context));
        expect((yield* mcp.get().pipe(Effect.provide(f.context))).runtime.status).toBe("disabled");
      }),
    ),
  );
});
