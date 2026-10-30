import { afterEach, expect, it } from "vitest";
import { ConfigProvider, Effect, Schema } from "effect";
import { mkdtemp, rm, chmod, lstat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { connect } from "node:net";
import { once } from "node:events";
import { McpClient, StdioTransport } from "@earendil-works/pi-mcp";
import { initialize } from "../../src/domain/mcp/localMcp";
import { serve } from "../../src/services/local-mcp/LocalMcpServer";
import { localMcpFixture, localMcpTarget } from "../app/helpers/localMcpHarness";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function directory() {
  // macOS's long TMPDIR plus the Unix socket length limit needs a short root.
  const path = await mkdtemp(join(process.platform === "darwin" ? "/tmp" : tmpdir(), "cake-mcp-"));
  directories.push(path);
  return path;
}
function client(path: string) {
  const transport = new StdioTransport({
    command: process.execPath,
    args: [resolve("scripts/cake-mcp.mjs"), path],
    stderr: "pipe",
  });
  return {
    transport,
    client: new McpClient({ name: "cake-test", version: "1", requestTimeoutMs: 5000 }),
  };
}
const content = (value: { content: readonly unknown[] }) => {
  const block = Schema.decodeUnknownSync(
    Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }),
  )(value.content[0]);
  return JSON.parse(block.text);
};

it("starts the real opt-in endpoint and stdio bridge with an actual MCP client", async () => {
  const path = await directory();
  const configuration = {
    directory: path,
    projects: ["/project"],
    scopes: ["read", "launch", "send", "todos.write"],
  };
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* localMcpFixture();
        yield* initialize().pipe(
          Effect.provide(f.context),
          Effect.provide(
            ConfigProvider.layer(
              ConfigProvider.fromUnknown({ CAKE_LOCAL_MCP: JSON.stringify(configuration) }),
            ),
          ),
        );
        yield* Effect.promise(async () => {
          const c = client(path);
          try {
            const initialized = await c.client.connect(c.transport);
            expect(initialized.serverInfo.name).toBe("cake-local");
            await c.client.ping();
            const tools = await c.client.listTools();
            expect(
              tools.find((tool) => tool.name === "sessions.create")?.inputSchema,
            ).toMatchObject({
              type: "object",
              required: expect.arrayContaining(["projectPath", "initialPrompt", "name"]),
            });
            expect(tools.some((tool) => tool.name === "sessions.cake")).toBe(false);
            expect(content(await c.client.callTool("projects.list"))).toMatchObject({
              projects: [{ path: "/project" }],
            });
            const launched = content(
              await c.client.callTool("sessions.create", {
                projectPath: "/project",
                name: "Task",
                initialPrompt: "Work",
              }),
            );
            expect(launched).toMatchObject({ status: "started", sessionId: expect.any(String) });
            expect(f.prompts.some((text) => text.includes("Work"))).toBe(true);
            expect(
              content(
                await c.client.callTool("sessions.send", {
                  projectPath: "/project",
                  sessionId: localMcpTarget,
                  text: "Continue",
                }),
              ),
            ).toMatchObject({ command: "sessions.send" });
            const created = content(
              await c.client.callTool("todos.create", {
                projectPath: "/project",
                title: "Task",
                description: "Work started",
              }),
            );
            expect(created).toMatchObject({
              command: "todos.create",
              result: { id: expect.any(String), committed: true },
            });
            const id = created.result.id;
            const revision = created.result.revision;
            expect(
              content(await c.client.callTool("todos.read", { projectPath: "/project", id })),
            ).toMatchObject({ result: { title: "Task", state: "open" } });
            expect(
              content(
                await c.client.callTool("todos.update", {
                  projectPath: "/project",
                  id,
                  expectedRevision: revision,
                  state: "done",
                }),
              ),
            ).toMatchObject({ result: { revision: revision + 1, committed: true } });
            expect(
              (
                await c.client.callTool("todos.update", {
                  projectPath: "/project",
                  id,
                  expectedRevision: revision,
                  title: "Stale",
                })
              ).isError,
            ).toBe(true);
            expect(
              (
                await c.client.callTool("sessions.create", {
                  projectPath: "/project",
                  name: "Task",
                  initialPrompt: "Work",
                  approved: true,
                })
              ).isError,
            ).toBe(true);
            expect(
              content(await c.client.callTool("projects.info", { projectPath: "/other" })),
            ).toMatchObject({ code: "denied" });
            expect(content(await c.client.callTool("sessions.cake", {}))).toMatchObject({
              code: "unsupported",
            });
            await expect(c.client.request("resources/list")).rejects.toThrow("not supported");
            await expect(c.client.request("tools/call", {})).rejects.toThrow("Expected tools/call");
            expect(c.transport.stderr).toBe("");
          } finally {
            await c.client.close();
          }
          // A proxy disconnect does not take down Cake or another integration.
          const second = client(path);
          try {
            await second.client.connect(second.transport);
            await second.client.ping();
          } finally {
            await second.client.close();
          }
        });
      }),
    ),
  );
  await expect(lstat(join(path, "cake.sock"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("is disabled without opt-in and rejects malformed host grants", async () => {
  const path = await directory();
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* localMcpFixture();
        yield* initialize().pipe(
          Effect.provide(f.context),
          Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}))),
        );
        for (const value of [
          "{",
          JSON.stringify({ directory: path, projects: ["/project"], scopes: ["admin"] }),
          JSON.stringify({ directory: path, projects: ["relative"] }),
        ]) {
          const result = yield* initialize().pipe(
            Effect.result,
            Effect.provide(f.context),
            Effect.provide(
              ConfigProvider.layer(ConfigProvider.fromUnknown({ CAKE_LOCAL_MCP: value })),
            ),
          );
          expect(result._tag).toBe("Failure");
        }
      }),
    ),
  );
  await expect(lstat(join(path, "cake.sock"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("defaults to read-only and denies hidden tools even when called by name", async () => {
  const path = await directory();
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* localMcpFixture();
        yield* initialize().pipe(
          Effect.provide(f.context),
          Effect.provide(
            ConfigProvider.layer(
              ConfigProvider.fromUnknown({
                CAKE_LOCAL_MCP: JSON.stringify({ directory: path, projects: ["/project"] }),
              }),
            ),
          ),
        );
        yield* Effect.promise(async () => {
          const c = client(path);
          try {
            await c.client.connect(c.transport);
            expect(
              (await c.client.listTools()).every((tool) => tool.annotations?.readOnlyHint),
            ).toBe(true);
            expect(
              content(
                await c.client.callTool("sessions.create", {
                  projectPath: "/project",
                  name: "Task",
                  initialPrompt: "Work",
                }),
              ),
            ).toMatchObject({ code: "denied" });
          } finally {
            await c.client.close();
          }
        });
      }),
    ),
  );
});

it("rejects unsafe directories and never replaces an existing socket", async () => {
  const path = await directory();
  const endpoint = { tools: [], call: async () => ({}) };
  await chmod(path, 0o755);
  await expect(Effect.runPromise(Effect.scoped(serve(path, endpoint)))).rejects.toThrow("0700");
  await chmod(path, 0o700);
  const linked = `${path}-link`;
  directories.push(linked);
  await symlink(path, linked);
  await expect(Effect.runPromise(Effect.scoped(serve(linked, endpoint)))).rejects.toThrow("0700");
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* serve(path, endpoint);
        const duplicate = yield* serve(path, endpoint).pipe(Effect.result);
        expect(duplicate._tag).toBe("Failure");
        expect(yield* Effect.promise(() => lstat(join(path, "cake.sock")))).toBeDefined();
      }),
    ),
  );
});

it("handles malformed protocol frames, initialization order and disconnect cancellation", async () => {
  const path = await directory();
  const { promise: entered, resolve: called } = Promise.withResolvers<void>();
  const { promise: cancelled, resolve: aborted } = Promise.withResolvers<void>();
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* serve(path, {
          tools: [],
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
            return { accepted: false };
          },
        });
        yield* Effect.promise(async () => {
          const socket = connect(join(path, "cake.sock"));
          await once(socket, "connect");
          const exchange = async (line: string) => {
            const response = once(socket, "data");
            socket.write(`${line}\n`);
            const [data] = await response;
            return JSON.parse(String(data));
          };
          expect(await exchange("{")).toMatchObject({ error: { code: -32700 } });
          expect(await exchange("[]")).toMatchObject({ error: { code: -32600 } });
          expect(
            await exchange(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })),
          ).toMatchObject({ error: { code: -32000 } });
          expect(
            await exchange(
              JSON.stringify({
                jsonrpc: "2.0",
                id: 2,
                method: "initialize",
                params: {
                  protocolVersion: "2024-11-05",
                  capabilities: {},
                  clientInfo: { name: "test", version: "1" },
                },
              }),
            ),
          ).toMatchObject({ result: { protocolVersion: "2024-11-05" } });
          socket.write(
            `${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "pending", arguments: {} } })}\n`,
          );
          await entered;
          socket.destroy();
          await cancelled;
        });
      }),
    ),
  );
});
