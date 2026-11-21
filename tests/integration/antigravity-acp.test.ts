import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { runAcpTurn, type AcpTurn } from "../../src/services/antigravity/acp";

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

it("reports connection failure and a subsequent new turn does not receive old events", async () => {
  await expect(runAcpTurn(turn({ text: "disconnect" }), launch)).rejects.toThrow("disconnected");
  const input = turn({ text: "again" });
  await runAcpTurn(input, launch);
  expect(input.chunk).toHaveBeenCalledTimes(2);
});
