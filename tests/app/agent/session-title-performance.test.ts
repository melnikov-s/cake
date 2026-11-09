import { SessionManager } from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { Effect } from "effect";
import { expect, it, vi } from "vitest";
import {
  makeSessionTitleReader,
  type SessionTitleReadMetrics,
} from "../../../src/services/pi/runtime/session-title";

/** Reproduce with pnpm test tests/app/agent/session-title-performance.test.ts. */
it("measures cold, unchanged, append and rename reads against the old synchronous fingerprint cache", async () => {
  const root = fs.mkdtempSync(join(tmpdir(), "cake-title-measure-"));
  const path = join(root, "large.jsonl");
  const serialize = (entry: unknown) => JSON.stringify(entry) + "\n";
  const info = (name: string) =>
    serialize({ type: "session_info", id: "name", parentId: null, name });
  const tool = serialize({
    type: "message",
    id: "tool",
    parentId: null,
    message: { role: "toolResult", content: [{ type: "text", text: "x".repeat(8_192) }] },
  });
  fs.writeFileSync(
    path,
    serialize({ type: "session", version: 3, id: "large", cwd: root }) +
      serialize({
        type: "message",
        id: "user",
        parentId: null,
        message: { role: "user", content: "Fallback", timestamp: 1 },
      }) +
      info("Original") +
      tool.repeat(4_096),
  );
  const samples: Array<Record<string, string | number>> = [];
  let baselineBytes = 0;
  const originalRead = fs.readSync;
  const readSpy = vi
    .spyOn(fs, "readSync")
    .mockImplementation((...args: Parameters<typeof fs.readSync>) => {
      const count = originalRead(...args);
      baselineBytes += count;
      return count;
    });
  syncBuiltinESMExports();
  // This fixture reproduces the replaced algorithm, not a new proposed cache.
  let cached: { fingerprint: string; title: string } | undefined;
  function baseline() {
    const start = performance.now();
    baselineBytes = 0;
    const canonical = fs.realpathSync(path);
    const stat = fs.statSync(canonical, { bigint: true });
    const fingerprint = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
    let recordsParsed = 0;
    if (cached?.fingerprint !== fingerprint) {
      const manager = SessionManager.open(path, dirname(path), root);
      recordsParsed = manager.getEntries().length + 1;
      const title = manager.getSessionName() ?? "Fallback";
      cached = { fingerprint, title };
    }
    const elapsed = performance.now() - start;
    return {
      title: cached.title,
      bytesRead: baselineBytes,
      recordsParsed,
      wallMs: elapsed,
      mainThreadGapMs: elapsed,
      heartbeatTicks: 0,
    };
  }
  let metrics: SessionTitleReadMetrics = { bytesRead: 0, recordsParsed: 0 };
  const reader = await Effect.runPromise(
    makeSessionTitleReader({
      measured: (value) => {
        metrics = value;
      },
    }),
  );
  async function replacement() {
    metrics = { bytesRead: 0, recordsParsed: 0 };
    let heartbeatTicks = 0;
    let last = performance.now();
    let mainThreadGapMs = 0;
    const start = last;
    const interval = setInterval(() => {
      const now = performance.now();
      mainThreadGapMs = Math.max(mainThreadGapMs, now - last);
      last = now;
      heartbeatTicks++;
    }, 1);
    try {
      const title = await Effect.runPromise(reader(path, root));
      const end = performance.now();
      mainThreadGapMs = Math.max(mainThreadGapMs, end - last);
      return { title, ...metrics, wallMs: end - start, mainThreadGapMs, heartbeatTicks };
    } finally {
      clearInterval(interval);
    }
  }
  try {
    for (const phase of ["cold", "unchanged", "append", "rename", "append-after-rename"] as const) {
      if (phase === "append" || phase === "append-after-rename") fs.appendFileSync(path, tool);
      if (phase === "rename") fs.appendFileSync(path, info("Renamed"));
      const before = baseline();
      const after = await replacement();
      expect(after.title).toBe(before.title);
      if (phase === "unchanged") {
        expect(before.bytesRead).toBe(0);
        expect(after.bytesRead).toBe(0);
      } else {
        expect(before.recordsParsed).toBeGreaterThan(4_000);
        expect(before.bytesRead).toBeGreaterThan(32 * 1024 * 1024);
        expect(after.recordsParsed).toBe(2); // header + latest session_info only
        if (phase === "cold" || phase === "append") {
          // Legacy early names still need a byte scan; do not pretend a cache
          // size or selective parsing eliminates that cold/changed-file cost.
          expect(after.bytesRead).toBeGreaterThan(32 * 1024 * 1024);
          expect(after.heartbeatTicks).toBeGreaterThan(0);
        } else {
          expect(after.bytesRead).toBeLessThan(3 * 64 * 1024);
        }
      }
      for (const [implementation, result] of [
        ["before", before],
        ["after", after],
      ] as const) {
        const { title: _title, ...measurements } = result;
        samples.push({ phase, implementation, ...measurements });
      }
    }
    console.log(
      "Title lookup fixture: 4096 x 8KiB tool records; actual readSync/read byte counts; real filesystem, not Electron. Baseline gap is synchronous call duration; after gap is 1ms heartbeat maximum (includes scheduler noise).\n" +
        JSON.stringify(samples, null, 2),
    );
  } finally {
    readSpy.mockRestore();
    syncBuiltinESMExports();
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
