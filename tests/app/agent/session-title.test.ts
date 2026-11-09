import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import * as fsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Effect } from "effect";
import { SESSION_TITLE_MAX_LENGTH } from "../../../src/contracts/conversations/session-contract";
import { addPresentationModeReminder } from "../../../src/contracts/conversations/presentation-mode-reminders";
import { addResponseModeReminder } from "../../../src/contracts/conversations/response-mode-reminders";
import { encodeCrossSessionMessage } from "../../../src/contracts/conversations/cross-session-message";
import {
  makeSessionTitleReader,
  sessionTitleFromFile,
  type SessionTitleReadMetrics,
} from "../../../src/services/pi/runtime/session-title";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open) };
});

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cake-title-cache-"));
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

function fixture(name = "session", title = "Explicit title", user = "Fallback title") {
  const manager = SessionManager.create(root, root);
  manager.appendMessage({ role: "user", content: user, timestamp: 1 });
  manager.appendSessionInfo(title);
  const source = manager.getSessionFile();
  if (!source) throw new Error("Fixture was not persisted");
  const path = join(root, `${name}.jsonl`);
  renameSync(source, path);
  return path;
}

function appendTitle(path: string, name: string) {
  appendFileSync(
    path,
    `\n${JSON.stringify({ type: "session_info", id: "title", parentId: null, timestamp: new Date().toISOString(), name })}\n`,
  );
}

const lookup = (path: string) => Effect.runPromise(sessionTitleFromFile(path, root));
async function measuredReader(capacity = 1_024) {
  const reads: SessionTitleReadMetrics[] = [];
  const read = await Effect.runPromise(
    makeSessionTitleReader({ capacity, measured: (metrics) => reads.push(metrics) }),
  );
  return { reads, read, lookup: (path: string) => Effect.runPromise(read(path, root)) };
}

// Raw legacy fixtures deliberately avoid SessionManager migrations and repair.
function legacy(entries: unknown[], name = "legacy") {
  const path = join(root, `${name}.jsonl`);
  writeFileSync(
    path,
    [{ type: "session", version: 1, id: name, cwd: root }, ...entries]
      .map((entry) => JSON.stringify(entry))
      .join("\n"),
  );
  return path;
}
const user = (content: unknown) => ({ type: "message", message: { role: "user", content } });

describe("read-only asynchronous Pi title metadata", () => {
  it("shares unchanged and concurrent misses without opening or projecting a SessionManager", async () => {
    const path = fixture("fallback", "", "x".repeat(SESSION_TITLE_MAX_LENGTH + 10));
    const open = vi.spyOn(SessionManager, "open");
    const entries = vi.spyOn(SessionManager.prototype, "getEntries");
    const reader = await measuredReader();
    const values = await Promise.all(Array.from({ length: 20 }, () => reader.lookup(path)));
    expect(values).toEqual(Array(20).fill("x".repeat(SESSION_TITLE_MAX_LENGTH)));
    await reader.lookup(path);
    expect(reader.reads).toHaveLength(1);
    expect(open).not.toHaveBeenCalled();
    expect(entries).not.toHaveBeenCalled();
  });

  it("is lazy until executed and limits explicit names too", async () => {
    const path = fixture("long-name", "  " + "é".repeat(SESSION_TITLE_MAX_LENGTH + 10) + "  ");
    const reader = await measuredReader();
    const effect = reader.read(path, root);
    expect(reader.reads).toHaveLength(0);
    expect(await Effect.runPromise(effect)).toBe("é".repeat(SESSION_TITLE_MAX_LENGTH));
  });

  it("shares canonical entries across relative routes, symlinks and cwd overrides", async () => {
    const path = fixture();
    const alias = join(root, "alias.jsonl");
    symlinkSync(path, alias);
    const reader = await measuredReader();
    expect(await reader.lookup(path)).toBe("Explicit title");
    expect(await reader.lookup(relative(process.cwd(), path))).toBe("Explicit title");
    expect(await Effect.runPromise(reader.read(alias, join(root, "other-cwd")))).toBe(
      "Explicit title",
    );
    expect(reader.reads).toHaveLength(1);
  });

  it("uses the latest physical rename across legacy branches, including explicit clears", async () => {
    const path = legacy([
      user("First branch fallback"),
      { type: "session_info", name: "Old name", id: "old", parentId: null },
      user("Other branch fallback"),
      { type: "session_info", name: "Latest branch name", id: "latest", parentId: null },
    ]);
    const before = readFileSync(path);
    expect(await lookup(path)).toBe("Latest branch name");
    expect(readFileSync(path)).toEqual(before);
    appendTitle(path, "");
    expect(await lookup(path)).toBe("First branch fallback");
    appendTitle(path, "Renamed again");
    expect(await lookup(path)).toBe("Renamed again");
    appendFileSync(path, JSON.stringify(user("A later turn")) + "\n");
    expect(await lookup(path)).toBe("Renamed again");
  });

  it("retains first meaningful visible user text and strips transport, attachments and both reminders", async () => {
    const id = "fc9e491a-d5d5-4dc4-a17c-c538a84a08a2";
    const envelope = (text: string) =>
      encodeCrossSessionMessage(text, {
        version: 1,
        messageId: id,
        threadId: id,
        sequence: 1,
        expectsResponse: false,
        sender: { sessionId: "sender", title: "Not the title", kind: "project-session" },
      });
    const decorate = (text: string) =>
      addResponseModeReminder(addPresentationModeReminder(text, "normal", "browser"), "voice");
    const attachment =
      '<cake-file-attachment>{"kind":"file","name":"notes.txt","path":"/tmp/notes.txt"}</cake-file-attachment>';
    const path = legacy([
      { type: "message", message: { role: "assistant", content: "Not user text" } },
      user("   "),
      user(decorate(envelope(attachment))),
      user([
        { type: "image", data: "not text" },
        { type: "text", text: decorate(envelope("  Visible request  \n" + attachment)) },
      ]),
      user("Later request"),
    ]);
    expect(await lookup(path)).toBe("Visible request");
  });

  it("preserves reordered/escaped JSON keys, text blocks and ID fallback", async () => {
    const path = legacy([{ name: "Reordered", type: "session_info" }]);
    expect(await lookup(path)).toBe("Reordered");
    appendFileSync(path, '\n{"t\\u0079pe":"session_info","name":"Escaped"}');
    expect(await lookup(path)).toBe("Escaped");
    expect(
      await lookup(
        legacy(
          [
            user([
              { type: "text", text: "One" },
              { type: "text", text: "Two" },
            ]),
          ],
          "blocks",
        ),
      ),
    ).toBe("One\nTwo");
    expect(await lookup(legacy([user("")], "id-only"))).toBe("id-only");
  });

  it("skips malformed/truncated lines and never repairs a missing final newline or old format", async () => {
    const path = legacy([user("Meaningful"), { type: "session_info", name: "Latest" }]);
    appendFileSync(path, '\nnot json\n{"type":"session_info","name":"unfinished');
    const before = readFileSync(path);
    const stats = statSync(path, { bigint: true });
    expect(await lookup(path)).toBe("Latest");
    expect(readFileSync(path)).toEqual(before);
    expect(statSync(path, { bigint: true }).mtimeNs).toBe(stats.mtimeNs);
  });

  it("detects same-size rewrites even with restored mtime", async () => {
    const path = fixture("rewrite", "Old title");
    const timestamp = new Date("2020-01-01");
    utimesSync(path, timestamp, timestamp);
    const before = statSync(path, { bigint: true });
    expect(await lookup(path)).toBe("Old title");
    writeFileSync(path, readFileSync(path, "utf8").replace("Old title", "New title"));
    utimesSync(path, timestamp, timestamp);
    expect(statSync(path, { bigint: true }).size).toBe(before.size);
    expect(await lookup(path)).toBe("New title");
  });

  it("detects atomic replacements and rewrite-plus-growth, not just pure appends", async () => {
    const path = fixture("original", "Old title");
    const replacement = join(root, "replacement.jsonl");
    writeFileSync(replacement, readFileSync(path, "utf8").replace("Old title", "New title"));
    const timestamp = new Date("2020-01-01");
    utimesSync(path, timestamp, timestamp);
    utimesSync(replacement, timestamp, timestamp);
    expect(await lookup(path)).toBe("Old title");
    renameSync(replacement, path);
    expect(await lookup(path)).toBe("New title");
    writeFileSync(
      path,
      readFileSync(path, "utf8").replace("New title", "Grown title") +
        JSON.stringify(user("Appended")) +
        "\n",
    );
    expect(await lookup(path)).toBe("Grown title");
  });

  it("never creates missing history or returns stale titles for deleted, empty or corrupt files", async () => {
    const path = fixture();
    expect(await lookup(path)).toBe("Explicit title");
    rmSync(path);
    await expect(lookup(path)).rejects.toThrow();
    expect(() => statSync(path)).toThrow();
    writeFileSync(path, "");
    await expect(lookup(path)).rejects.toThrow();
    expect(statSync(path).size).toBe(0);
    await expect(lookup(root)).rejects.toThrow();
    for (const corrupt of ["not a Pi session\n", JSON.stringify(user("No header"))]) {
      writeFileSync(path, corrupt);
      await expect(lookup(path)).rejects.toThrow();
      expect(readFileSync(path, "utf8")).toBe(corrupt);
    }
    fixture("session", "Recovered");
    expect(await lookup(path)).toBe("Recovered");
  });

  it("refreshes symlink retargets and title reads at restored/moved paths", async () => {
    const first = fixture("first", "First");
    const second = fixture("second", "Second");
    const alias = join(root, "alias.jsonl");
    symlinkSync(first, alias);
    expect(await lookup(alias)).toBe("First");
    rmSync(alias);
    symlinkSync(second, alias);
    expect(await lookup(alias)).toBe("Second");
    const restored = join(root, "restored.jsonl");
    renameSync(second, restored);
    expect(await lookup(restored)).toBe("Second");
  });

  it("does not negative-cache read failures", async () => {
    const path = fixture();
    const reader = await measuredReader();
    vi.mocked(fsPromises.open).mockRejectedValueOnce(new Error("read failed"));
    await expect(reader.lookup(path)).rejects.toThrow();
    expect(await reader.lookup(path)).toBe("Explicit title");
    expect(reader.reads).toHaveLength(1);
  });

  it("retries changed reads, but bounds retries for persistently changing files", async () => {
    const path = fixture();
    let count = 0;
    const read = await Effect.runPromise(
      makeSessionTitleReader({
        measured: () => {
          if (count++ === 0) appendTitle(path, "Appended during lookup");
        },
      }),
    );
    expect(await Effect.runPromise(read(path, root))).toBe("Appended during lookup");
    expect(count).toBe(2);
    const unstable = await Effect.runPromise(
      makeSessionTitleReader({
        measured: () => {
          appendTitle(path, "Still changing");
        },
      }),
    );
    await expect(Effect.runPromise(unstable(path, root))).rejects.toThrow();
    expect(await lookup(path)).toBe("Still changing");
  });

  it("uses Effect capacity eviction without retaining history or handles", async () => {
    const reader = await measuredReader(2);
    const paths = [fixture("one"), fixture("two"), fixture("three")];
    for (const path of paths) await reader.lookup(path);
    expect(reader.reads).toHaveLength(3);
    await reader.lookup(paths[2] ?? "missing");
    expect(reader.reads).toHaveLength(3);
    await reader.lookup(paths[0] ?? "missing");
    expect(reader.reads).toHaveLength(4);
  });

  it("does not read for an already interrupted caller", async () => {
    const path = fixture();
    const reader = await measuredReader();
    const controller = new AbortController();
    controller.abort();
    await expect(
      Effect.runPromise(reader.read(path, root), { signal: controller.signal }),
    ).rejects.toThrow();
    expect(reader.reads).toHaveLength(0);
    expect(await reader.lookup(path)).toBe("Explicit title");
  });

  it("closes the read-only handle after interruption and permits a fresh lookup", async () => {
    const path = fixture();
    const reader = await measuredReader();
    const controller = new AbortController();
    const closed = Promise.withResolvers<void>();
    const originalOpen = vi.mocked(fsPromises.open).getMockImplementation();
    if (!originalOpen) throw new Error("Missing filesystem implementation");
    vi.mocked(fsPromises.open).mockImplementationOnce(async (...args) => {
      const file = await originalOpen(...args);
      const originalClose = file.close.bind(file);
      const close = vi.spyOn(file, "close").mockImplementation(async () => {
        await originalClose();
        closed.resolve();
      });
      const originalRead = file.read.bind(file);
      vi.spyOn(file, "read").mockImplementationOnce((...readArgs: Parameters<typeof file.read>) => {
        controller.abort();
        return originalRead(...readArgs);
      });
      expect(close).not.toHaveBeenCalled();
      return file;
    });
    await expect(
      Effect.runPromise(reader.read(path, root), { signal: controller.signal }),
    ).rejects.toThrow();
    await closed.promise;
    expect(await reader.lookup(path)).toBe("Explicit title");
  });

  it("skips giant irrelevant records with bounded buffers; refuses oversized title candidates honestly", async () => {
    const path = legacy([user("Fallback")]);
    appendFileSync(
      path,
      "\n" +
        JSON.stringify({
          type: "message",
          message: { role: "toolResult", content: "x".repeat(9 * 1024 * 1024) },
        }) +
        "\n",
    );
    expect(await lookup(path)).toBe("Fallback");
    appendTitle(path, "Latest");
    expect(await lookup(path)).toBe("Latest");
    const oversized = legacy([user("x".repeat(9 * 1024 * 1024))], "oversized");
    await expect(lookup(oversized)).rejects.toThrow();
  });
});
