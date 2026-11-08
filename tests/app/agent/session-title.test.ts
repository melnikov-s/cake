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
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SESSION_TITLE_MAX_LENGTH } from "../../../src/contracts/conversations/session-contract";
import { sessionTitleFromFile } from "../../../src/services/pi/runtime/session-title";

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
    `${JSON.stringify({ type: "session_info", id: "title", parentId: null, timestamp: new Date().toISOString(), name })}\n`,
  );
}

const lookup = (path: string) => sessionTitleFromFile(path, root);

describe("sessionTitleFromFile metadata cache", () => {
  it("opens/projects an unchanged transcript once, retaining the truncated fallback title", () => {
    const path = fixture("fallback", "", "x".repeat(SESSION_TITLE_MAX_LENGTH + 10));
    const open = vi.spyOn(SessionManager, "open");
    const entries = vi.spyOn(SessionManager.prototype, "getEntries");
    for (let index = 0; index < 20; index++) {
      expect(lookup(path)).toBe("x".repeat(SESSION_TITLE_MAX_LENGTH));
    }
    expect(open).toHaveBeenCalledTimes(1);
    expect(entries).toHaveBeenCalledTimes(1);
  });

  it("shares canonical-path entries across relative paths, symlinks and cwd overrides", () => {
    const path = fixture();
    const alias = join(root, "alias.jsonl");
    symlinkSync(path, alias);
    const open = vi.spyOn(SessionManager, "open");
    expect(lookup(path)).toBe("Explicit title");
    expect(lookup(relative(process.cwd(), path))).toBe("Explicit title");
    expect(sessionTitleFromFile(alias, join(root, "other-cwd"))).toBe("Explicit title");
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("refreshes appends, explicit title updates and cleared titles", () => {
    const path = fixture();
    const open = vi.spyOn(SessionManager, "open");
    expect(lookup(path)).toBe("Explicit title");
    appendTitle(path, "Renamed");
    expect(lookup(path)).toBe("Renamed");
    appendTitle(path, "");
    expect(lookup(path)).toBe("Fallback title");
    expect(lookup(path)).toBe("Fallback title");
    expect(open).toHaveBeenCalledTimes(3);
  });

  it("detects same-size rewrites with restored mtime via ctime", () => {
    const path = fixture("rewrite", "Old title");
    utimesSync(path, new Date("2020-01-01"), new Date("2020-01-01"));
    const before = statSync(path, { bigint: true });
    expect(lookup(path)).toBe("Old title");
    writeFileSync(path, readFileSync(path, "utf8").replace("Old title", "New title"));
    utimesSync(path, new Date("2020-01-01"), new Date("2020-01-01"));
    const after = statSync(path, { bigint: true });
    expect(after.size).toBe(before.size);
    expect(after.mtimeNs).toBe(before.mtimeNs);
    expect(after.ctimeNs).not.toBe(before.ctimeNs);
    expect(lookup(path)).toBe("New title");
  });

  it("detects atomic replacements even with matching size and mtime", () => {
    const path = fixture("original", "Old title");
    const replacement = join(root, "replacement.jsonl");
    writeFileSync(replacement, readFileSync(path, "utf8").replace("Old title", "New title"));
    const timestamp = new Date("2020-01-01");
    utimesSync(path, timestamp, timestamp);
    utimesSync(replacement, timestamp, timestamp);
    const before = statSync(path, { bigint: true });
    expect(lookup(path)).toBe("Old title");
    renameSync(replacement, path);
    const after = statSync(path, { bigint: true });
    expect(after.size).toBe(before.size);
    expect(after.mtimeNs).toBe(before.mtimeNs);
    expect(after.ino).not.toBe(before.ino);
    expect(lookup(path)).toBe("New title");
  });

  it("does not return a cached or generated title for deleted paths; recreation refreshes", () => {
    const path = fixture();
    expect(lookup(path)).toBe("Explicit title");
    rmSync(path);
    const open = vi.spyOn(SessionManager, "open");
    expect(() => lookup(path)).toThrow();
    expect(open).not.toHaveBeenCalled();
    expect(() => statSync(path)).toThrow();
    fixture("session", "Recreated");
    expect(lookup(path)).toBe("Recreated");
  });

  it("refreshes when a symlink is retargeted", () => {
    const first = fixture("first", "First");
    const second = fixture("second", "Second");
    const alias = join(root, "alias.jsonl");
    symlinkSync(first, alias);
    expect(lookup(alias)).toBe("First");
    rmSync(alias);
    symlinkSync(second, alias);
    expect(lookup(alias)).toBe("Second");
  });

  it("rejects empty, nonregular and corrupt files without keeping the old title", () => {
    const path = fixture();
    expect(lookup(path)).toBe("Explicit title");
    writeFileSync(path, "");
    expect(() => lookup(path)).toThrow("nonempty regular file");
    expect(statSync(path).size).toBe(0);
    expect(() => lookup(root)).toThrow("nonempty regular file");
    writeFileSync(path, "not a Pi session\n");
    expect(() => lookup(path)).toThrow();
    fixture("session", "Recovered");
    expect(lookup(path)).toBe("Recovered");
  });

  it("propagates open failures without negative caching or falling back to a stale title", () => {
    const path = fixture();
    expect(lookup(path)).toBe("Explicit title");
    appendTitle(path, "Updated");
    const open = vi.spyOn(SessionManager, "open");
    open.mockImplementationOnce(() => {
      throw new Error("read failed");
    });
    expect(() => lookup(path)).toThrow("read failed");
    expect(lookup(path)).toBe("Updated");
    expect(lookup(path)).toBe("Updated");
    expect(open).toHaveBeenCalledTimes(2);
  });

  it("retries a changed read and caches only the stable title", () => {
    const path = fixture();
    const originalOpen = SessionManager.open;
    const open = vi.spyOn(SessionManager, "open");
    open.mockImplementationOnce((...args) => {
      const manager = originalOpen(...args);
      appendTitle(path, "Appended during read");
      return manager;
    });
    expect(lookup(path)).toBe("Appended during read");
    expect(lookup(path)).toBe("Appended during read");
    expect(open).toHaveBeenCalledTimes(2);
  });

  it("bounds retries and never caches a persistently changing read", () => {
    const path = fixture();
    const originalOpen = SessionManager.open;
    const open = vi.spyOn(SessionManager, "open").mockImplementation((...args) => {
      const manager = originalOpen(...args);
      appendTitle(path, "Still changing");
      return manager;
    });
    expect(() => lookup(path)).toThrow("changed while reading");
    expect(open).toHaveBeenCalledTimes(2);
    open.mockRestore();
    const stableOpen = vi.spyOn(SessionManager, "open");
    expect(lookup(path)).toBe("Still changing");
    expect(lookup(path)).toBe("Still changing");
    expect(stableOpen).toHaveBeenCalledTimes(1);
  });

  it("allows Pi's newline repair before caching a stable title", () => {
    const path = fixture();
    writeFileSync(path, readFileSync(path, "utf8").trimEnd());
    const open = vi.spyOn(SessionManager, "open");
    expect(lookup(path)).toBe("Explicit title");
    expect(lookup(path)).toBe("Explicit title");
    expect(open).toHaveBeenCalledTimes(2);
  });

  it("bounds growth to 1024 titles and evicts the least recently used entry", () => {
    const first = fixture("lru-first");
    const second = fixture("lru-second");
    const rest = Array.from({ length: 1_022 }, (_, index) => fixture(`lru-${index}`));
    const newest = fixture("lru-newest");
    const open = vi.spyOn(SessionManager, "open");
    for (const path of [first, second, ...rest]) lookup(path);
    expect(lookup(first)).toBe("Explicit title");
    expect(lookup(newest)).toBe("Explicit title");
    expect(open).toHaveBeenCalledTimes(1_025);
    expect(lookup(first)).toBe("Explicit title");
    expect(open).toHaveBeenCalledTimes(1_025);
    expect(lookup(second)).toBe("Explicit title");
    expect(open).toHaveBeenCalledTimes(1_026);
  });
});
