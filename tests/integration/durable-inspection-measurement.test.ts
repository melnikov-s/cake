import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { createProjectSessionRuntime } from "../../src/layers/CakeOperations";
import { inspectSessionHistory } from "../../src/services/pi/runtime/session-inspection";
import { durableAnswer } from "../fixtures/durable-chat";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { readDurableChatSummary } from "../../src/services/pi-durable/durable-chat-catalog";

it("measures cold regular-session inspection without provider calls", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cake-cold-inspection-"));
  const sessionDir = join(directory, "sessions");
  const session = SessionManager.create(directory, sessionDir);
  session.appendMessage({ role: "user", content: "Recorded input", timestamp: 1 });
  session.appendMessage(durableAnswer("Recorded answer"));
  const sessionFile = session.getSessionFile();
  if (!sessionFile) throw new Error("Fixture session was not persisted");
  const before = await readFile(sessionFile, "utf8");
  const modelRuntime = vi.spyOn(ModelRuntime, "create");
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValue(new Error("No provider calls allowed"));
  const events: string[] = [];
  vi.stubEnv("PI_CODING_AGENT_DIR", join(directory, "agent"));
  try {
    const diskStart = performance.now();
    const diskHistory = inspectSessionHistory(SessionManager.open(sessionFile), {});
    const diskMs = performance.now() - diskStart;
    const runtimeStart = performance.now();
    const runtime = await createProjectSessionRuntime({
      cwd: directory,
      agentDir: join(directory, "agent"),
      trusted: true,
      sessionDir,
      directSessionDir: true,
      sessionFile,
      newSession: false,
      onEvent: (event) => events.push(event.type),
      requestUi: async () => undefined,
    });
    const acquisitionMs = performance.now() - runtimeStart;
    const afterAcquisition = await readFile(sessionFile, "utf8");
    try {
      const history = await runtime.inspectSession({ kind: "history" });
      const compactions = await runtime.inspectSession({ kind: "compactions" });
      await runtime.inspectSession({ kind: "tree" });
      expect(history).toEqual(inspectSessionHistory(SessionManager.open(sessionFile), {}));
      expect(diskHistory).toMatchObject({ total: 2 });
      expect(compactions).toMatchObject({ entries: [] });
      expect(fetch).not.toHaveBeenCalled();
      expect(await readFile(sessionFile, "utf8")).toBe(afterAcquisition);
      process.stdout.write(
        `${JSON.stringify({ diskMs, acquisitionMs, modelRuntimeCreates: modelRuntime.mock.calls.length, events, providerCalls: fetch.mock.calls.length, acquisitionChangedTranscript: before !== afterAcquisition, appended: afterAcquisition.slice(before.length) })}\n`,
      );
    } finally {
      await runtime.dispose();
    }
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  }
});

it("measures isolated catalog initialization and write-lock acquisition", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cake-catalog-measure-"));
  const path = join(directory, "coordinator.sqlite");
  const storage = await openNodeSqliteStorage(path);
  await storage.close(BACKGROUND_CONTEXT);
  const exec = vi.spyOn(DatabaseSync.prototype, "exec");
  try {
    const started = performance.now();
    for (let i = 0; i < 20; i++) await readDurableChatSummary(directory);
    const durationMs = performance.now() - started;
    const counts = {
      reads: 20,
      transactions: exec.mock.calls.filter(([sql]) => sql === "BEGIN IMMEDIATE").length,
      checkpoints: exec.mock.calls.filter(([sql]) => sql === "PRAGMA wal_checkpoint(TRUNCATE)")
        .length,
      durationMs,
    };
    expect(counts.transactions).toBe(20);
    expect(counts.checkpoints).toBe(20);
    // Use a zero-timeout connection to demonstrate lock ownership, not a wall-clock assertion.
    const writer = new DatabaseSync(path, { timeout: 0 });
    writer.exec("BEGIN IMMEDIATE");
    let locked = false;
    try {
      await expect(openNodeSqliteStorage(path, { busyTimeoutMs: 0 })).rejects.toThrow("locked");
      locked = true;
      expect(writer.prepare("SELECT count(*) AS n FROM conversations").get()).toEqual({ n: 0 });
    } finally {
      writer.exec("ROLLBACK");
      writer.close();
    }
    process.stdout.write(`${JSON.stringify({ ...counts, writerBlocksInitialization: locked })}\n`);
  } finally {
    exec.mockRestore();
    await rm(directory, { recursive: true, force: true });
  }
});
