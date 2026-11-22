import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  discoverAntigravityModels,
  runAcpTurn,
  type AcpTurn,
} from "../../src/services/antigravity/acp";

let cwd: string;
beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "cake-acp-"));
});
afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});
const fixture = resolve(import.meta.dirname, "../fixtures/antigravity-acp.mjs");
const launch = (cwd: string) =>
  spawn(process.execPath, [fixture, "acp"], {
    cwd,
    detached: process.platform !== "win32",
    stdio: "pipe",
  });
const turn = (patch: Partial<AcpTurn> = {}): AcpTurn => ({
  cwd,
  text: "hello",
  signal: new AbortController().signal,
  status: vi.fn(),
  chunk: vi.fn(),
  tool: vi.fn(),
  permission: vi.fn(async () => undefined),
  ...patch,
});
const wire = () => readFile(join(cwd, "fixture-acp-wire.ndjson"), "utf8");

it("negotiates Cake as a text-only client and resumes without uploading history", async () => {
  const first = turn();
  const done = await runAcpTurn(first, launch);
  if (!done.resumeId) throw new Error("Expected an advertised resume capability");
  expect(first.status).toHaveBeenLastCalledWith("new");
  expect(first.chunk).toHaveBeenCalledTimes(2);
  expect(first.chunk).toHaveBeenNthCalledWith(1, "ACP first chunk · café");
  expect(first.chunk).toHaveBeenLastCalledWith(" + final chunk");
  const next = turn({ text: "next", resumeId: done.resumeId });
  await runAcpTurn(next, launch);
  expect(next.status).toHaveBeenLastCalledWith("resumed");
  expect(next.chunk).toHaveBeenCalledTimes(2);
  const protocol = await wire();
  expect(protocol).toContain('"clientCapabilities":{},"clientInfo":{"name":"cake","title":"Cake"');
  expect(protocol).toContain(
    `"method":"session/resume","params":{"cwd":${JSON.stringify(cwd)},"mcpServers":[],"sessionId":${JSON.stringify(done.resumeId)}`,
  );
  expect(protocol.match(/"text":"hello"/g)).toHaveLength(1);
  expect(protocol.match(/"text":"next"/g)).toHaveLength(1);
  expect(protocol).not.toContain("session/load");
  expect(protocol).not.toContain("session/set_config_option");
});

it("discovers in a new empty scratch directory with no prompt or MCP, then removes it", async () => {
  let scratch: string | undefined;
  let listing: Promise<string[]> | undefined;
  let child: ReturnType<typeof launch> | undefined;
  const catalog = await discoverAntigravityModels(
    new AbortController().signal,
    (dir, discovery) => {
      expect(discovery).toBe(true);
      scratch = dir;
      listing = readdir(dir);
      return (child = spawn(process.execPath, [fixture, "acp"], {
        cwd: dir,
        env: { ...process.env, CAKE_FIXTURE_WIRE: join(cwd, "fixture-acp-wire.ndjson") },
        detached: process.platform !== "win32",
        stdio: "pipe",
      }));
    },
  );
  if (!scratch || !listing || !child) throw new Error("Probe did not launch");
  expect(scratch).not.toBe(cwd);
  expect(await listing).toEqual([]);
  await expect(readdir(scratch)).rejects.toMatchObject({ code: "ENOENT" });
  expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  expect(catalog).toContainEqual({
    modelId: "fixture-sonnet-medium",
    name: "Fixture Sonnet (Medium)",
  });
  expect(frames(await wire()).map(({ method }) => method)).toEqual(["initialize", "session/new"]);
  expect(frames(await wire())[1]?.params).toEqual({ cwd: scratch, mcpServers: [] });
});

it("aborts a stalled probe and waits for child and scratch cleanup", async () => {
  const controller = new AbortController();
  let scratch: string | undefined;
  let child: ReturnType<typeof launch> | undefined;
  const probe = discoverAntigravityModels(controller.signal, (dir) => {
    scratch = dir;
    child = spawn(process.execPath, [fixture, "acp"], {
      cwd: dir,
      env: { ...process.env, CAKE_FIXTURE_HOLD_INITIALIZE: "1" },
      detached: process.platform !== "win32",
      stdio: "pipe",
    });
    void once(child.stderr, "data").then(() => controller.abort());
    return child;
  });
  await expect(probe).rejects.toThrow("canceled");
  if (!scratch || !child) throw new Error("Probe did not launch");
  await expect(readdir(scratch)).rejects.toMatchObject({ code: "ENOENT" });
  expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
});

const frames = (wire: string) =>
  wire
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));

it("applies the exact pin before prompting both a new session and a cold resume", async () => {
  const modelId = "fixture-sonnet-medium";
  const fresh = await runAcpTurn(turn({ modelId }), launch);
  const resumed = turn({ modelId, resumeId: fresh.resumeId });
  await runAcpTurn(resumed, launch);
  expect(resumed.status).toHaveBeenLastCalledWith("resumed");
  const protocol = frames(await wire());
  expect(protocol.map(({ method }) => method)).toEqual([
    "initialize",
    "session/new",
    "session/set_config_option",
    "session/prompt",
    "initialize",
    "session/resume",
    "session/set_config_option",
    "session/prompt",
  ]);
  expect(
    protocol
      .filter(({ method }) => method === "session/set_config_option")
      .map(({ params }) => params),
  ).toEqual([
    { sessionId: fresh.resumeId, configId: "model", value: modelId },
    { sessionId: fresh.resumeId, configId: "model", value: modelId },
  ]);
});

it.each([
  {
    modelId: "removed-model-medium",
    marker: undefined,
    setter: false,
    error: "does not offer that model",
  },
  {
    modelId: "fixture-sonnet-medium",
    marker: "fixture-reject-model",
    setter: true,
    error: "rejected the selection",
  },
  {
    modelId: "fixture-sonnet-medium",
    marker: "fixture-mismatch-model",
    setter: true,
    error: "did not confirm the requested model and effort",
  },
])("sends no prompt if a pinned model $error", async ({ modelId, marker, setter, error }) => {
  if (marker) await writeFile(join(cwd, marker), "");
  await expect(runAcpTurn(turn({ modelId, resumeId: "previous" }), launch)).rejects.toThrow(
    new RegExp(`${error}.*No prompt was sent`),
  );
  expect(frames(await wire()).map(({ method }) => method)).toEqual([
    "initialize",
    "session/resume",
    ...(setter ? ["session/set_config_option"] : []),
  ]);
});

it.each(["allow", "deny"] as const)(
  "offers a real per-call permission and forwards %s once",
  async (decision) => {
    const permission = vi.fn<AcpTurn["permission"]>(async () => decision);
    const input = turn({ text: "permission", permission });
    const result = await runAcpTurn(input, launch);
    expect(permission).toHaveBeenCalledOnce();
    expect(permission.mock.calls[0]?.[0]).toMatchObject({
      canAllowOnce: true,
      description: expect.stringContaining("echo fixture-only"),
    });
    expect(input.tool).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: decision === "allow" ? "completed" : "failed" }),
    );
    expect(result.stop).toBe("end_turn");
    expect(await wire()).toContain(`"optionId":"${decision === "allow" ? "yes" : "no"}"`);
  },
);

it("abandons pending permission, sends cancel, and rejects late events and approvals", async () => {
  const controller = new AbortController();
  let lateApproval: (() => void) | undefined;
  const permission: AcpTurn["permission"] = (_request, signal) =>
    new Promise((resolve) => {
      lateApproval = () => resolve("allow");
      signal.addEventListener("abort", () => resolve(undefined), { once: true });
      controller.abort();
    });
  const input = turn({ signal: controller.signal, text: "permission", permission });
  expect(await runAcpTurn(input, launch)).toEqual({ stop: "cancelled" });
  lateApproval?.();
  expect(input.chunk).toHaveBeenCalledTimes(1);
  const protocol = await wire();
  expect(protocol).toContain('"method":"session/cancel"');
  expect(protocol).toContain('"outcome":"cancelled"');
  expect(protocol).not.toContain('"outcome":"selected"');
});

it.each([
  ["fixture-no-resume", "no-resume"],
  ["fixture-reject-resume", "resume-unavailable"],
] as const)("starts clean after %s and discloses it", async (marker, status) => {
  await writeFile(join(cwd, marker), "");
  const input = turn({ resumeId: "previous" });
  const result = await runAcpTurn(input, launch);
  expect(input.status).toHaveBeenLastCalledWith(status);
  expect(Boolean(result.resumeId)).toBe(marker !== "fixture-no-resume");
  expect(await wire()).not.toContain("session/load");
  if (marker === "fixture-no-resume") expect(await wire()).not.toContain("session/resume");
});

it("reports missing official CLI, auth and incompatible protocol without exposing raw errors", async () => {
  await expect(
    runAcpTurn(turn(), (cwd) => spawn(join(cwd, "not-installed"), [], { cwd, stdio: "pipe" })),
  ).rejects.toThrow("not on Cake’s PATH");
  await writeFile(join(cwd, "fixture-auth-required"), "");
  await expect(runAcpTurn(turn(), launch)).rejects.toThrow(/^Antigravity sign-in required\./);
  expect(await wire()).not.toContain('"method":"session/prompt"');
  await writeFile(join(cwd, "fixture-wrong-version"), "");
  await expect(runAcpTurn(turn(), launch)).rejects.toThrow("ACP v1 protocol");
});

it("dismisses a pending permission when the ACP process disconnects", async () => {
  let child: ReturnType<typeof launch> | undefined;
  let permissionSignal: AbortSignal | undefined;
  const input = turn({
    text: "permission",
    permission: async (_request, signal) => {
      permissionSignal = signal;
      child?.kill("SIGKILL");
      return await new Promise((resolve) => {
        signal.addEventListener("abort", () => resolve(undefined), { once: true });
      });
    },
  });
  await expect(runAcpTurn(input, (cwd) => (child = launch(cwd)))).rejects.toThrow("disconnected");
  expect(permissionSignal?.aborted).toBe(true);
  expect(await wire()).not.toContain('"outcome":"selected"');
});

it("does not send the prompt if the CLI ignores the provisioned Cake tool", async () => {
  await writeFile(join(cwd, "fixture-ignore-mcp"), "");
  const cakeCall = vi.fn(async () => ({ text: "Never called" }));
  await expect(runAcpTurn(turn({ cakeCall }), launch)).rejects.toThrow("did not discover");
  expect(cakeCall).not.toHaveBeenCalled();
  expect(await wire()).not.toContain('"method":"session/prompt"');
});

it("interrupts an in-flight Cake call and revokes its endpoint on ACP disconnect", async () => {
  let child: ReturnType<typeof launch> | undefined;
  let interrupted = false;
  const input = turn({
    text: 'fixture Cake [{"command":"todos.list"}]',
    cakeCall: async (_args, { signal }) =>
      new Promise((resolve) => {
        signal.addEventListener(
          "abort",
          () => {
            interrupted = true;
            resolve({ text: "Late result" });
          },
          { once: true },
        );
        child?.kill("SIGKILL");
      }),
  });
  await expect(runAcpTurn(input, (cwd) => (child = launch(cwd)))).rejects.toThrow("disconnected");
  expect(interrupted).toBe(true);
  expect(input.chunk).not.toHaveBeenCalledWith("Late result");
  const setup = (await wire())
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .find((frame) => frame.method === "session/new");
  await expect(fetch(setup.params.mcpServers[0].url)).rejects.toThrow();
});

it("reports connection failure and a subsequent new turn does not receive old events", async () => {
  await expect(runAcpTurn(turn({ text: "disconnect" }), launch)).rejects.toThrow("disconnected");
  const input = turn({ text: "again" });
  await runAcpTurn(input, launch);
  expect(input.chunk).toHaveBeenCalledTimes(2);
});
