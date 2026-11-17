import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { expect, it } from "vitest";
import {
  makeSessionTitleReader,
  type SessionTitleReadMetrics,
} from "../../../src/services/pi/runtime/session-title";

/** Reproduce with pnpm test tests/app/agent/session-title-performance.test.ts. */
it("bounds title parsing and recent-rename I/O while yielding during large scans", async () => {
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
  let metrics: SessionTitleReadMetrics = { bytesRead: 0, recordsParsed: 0 };
  const reader = await Effect.runPromise(
    makeSessionTitleReader({
      measured: (value) => {
        metrics = value;
      },
    }),
  );
  async function lookup() {
    metrics = { bytesRead: 0, recordsParsed: 0 };
    let heartbeatTicks = 0;
    const interval = setInterval(() => {
      heartbeatTicks++;
    }, 1);
    try {
      const title = await Effect.runPromise(reader(path, root));
      return { title, ...metrics, heartbeatTicks };
    } finally {
      clearInterval(interval);
    }
  }
  try {
    for (const phase of ["cold", "unchanged", "append", "rename", "append-after-rename"] as const) {
      if (phase === "append" || phase === "append-after-rename") fs.appendFileSync(path, tool);
      if (phase === "rename") fs.appendFileSync(path, info("Renamed"));
      const after = await lookup();
      expect(after.title).toBe(
        phase === "rename" || phase === "append-after-rename" ? "Renamed" : "Original",
      );
      if (phase === "unchanged") {
        expect(after.bytesRead).toBe(0);
      } else {
        expect(after.recordsParsed).toBeLessThanOrEqual(2); // header + latest session_info budget
        if (phase === "cold" || phase === "append") {
          // A full-history scan must yield; reading fewer bytes is a valid optimization.
          if (after.bytesRead > 32 * 1024 * 1024) expect(after.heartbeatTicks).toBeGreaterThan(0);
        } else {
          expect(after.bytesRead).toBeLessThan(3 * 64 * 1024);
        }
      }
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
