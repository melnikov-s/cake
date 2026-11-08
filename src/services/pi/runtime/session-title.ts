import { SessionManager } from "@earendil-works/pi-coding-agent";
import { realpathSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { SESSION_TITLE_MAX_LENGTH } from "../../../contracts/conversations/session-contract";
import { textFromContent } from "./tool-projection";
import { visibleUserMessageText } from "./user-message-transport";
import { stripPresentationModeReminder } from "../../../contracts/conversations/presentation-mode-reminders";
import { stripResponseModeReminder } from "../../../contracts/conversations/response-mode-reminders";

function sessionTitle(sessionManager: SessionManager) {
  const name = sessionManager.getSessionName();
  if (name) return name.slice(0, SESSION_TITLE_MAX_LENGTH);
  for (const entry of sessionManager.getEntries()) {
    if (entry.type !== "message" || entry.message.role !== "user") continue;
    const text = visibleUserMessageText(
      stripResponseModeReminder(
        stripPresentationModeReminder(textFromContent(entry.message.content)),
      ),
    ).trim();
    if (text) return text.slice(0, SESSION_TITLE_MAX_LENGTH);
  }
  return sessionManager.getSessionId().slice(0, SESSION_TITLE_MAX_LENGTH);
}

// Keep only derived titles, never SessionManagers or transcript entries. A bounded LRU
// avoids retaining metadata for every session ever encountered by this process.
const TITLE_CACHE_CAPACITY = 1_024;
const titleCache = new Map<string, { fingerprint: string; title: string }>();

function titleFileMetadata(path: string) {
  const canonicalPath = realpathSync(path);
  const stat = statSync(canonicalPath, { bigint: true });
  // Pi initializes empty/missing files when opened. A catalog lookup must not
  // create a random title (or mutate an empty file) for an unavailable session.
  if (!stat.isFile() || stat.size === 0n) {
    titleCache.delete(canonicalPath);
    throw new Error(`Session title requires a nonempty regular file: ${path}`);
  }
  return {
    canonicalPath,
    // ctime catches same-size rewrites even when a writer restores mtime;
    // device/inode also distinguish atomic replacements at the same path.
    fingerprint: `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`,
  };
}

export function sessionTitleFromFile(path: string, cwd: string) {
  // A second attempt permits Pi's own newline repair/migration or an append
  // during the read. Never cache or return a title from an unstable read.
  for (let attempt = 0; attempt < 2; attempt++) {
    const before = titleFileMetadata(path);
    const cached = titleCache.get(before.canonicalPath);
    titleCache.delete(before.canonicalPath);
    if (cached?.fingerprint === before.fingerprint) {
      titleCache.set(before.canonicalPath, cached);
      return cached.title;
    }

    const title = sessionTitle(SessionManager.open(path, dirname(path), cwd));
    const after = titleFileMetadata(path);
    if (before.canonicalPath !== after.canonicalPath || before.fingerprint !== after.fingerprint) {
      continue;
    }
    titleCache.set(after.canonicalPath, { fingerprint: after.fingerprint, title });
    if (titleCache.size > TITLE_CACHE_CAPACITY) {
      const oldestPath = titleCache.keys().next().value;
      if (oldestPath !== undefined) titleCache.delete(oldestPath);
    }
    return title;
  }
  throw new Error(`Session file changed while reading its title: ${path}`);
}
