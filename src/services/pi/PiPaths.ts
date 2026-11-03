import {
  CONFIG_DIR_NAME,
  getAgentDir,
  SettingsManager,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** Pi resolves its own agent home. Cake must never overwrite its process environment. */
export const piAgentDirectory = () => resolve(getAgentDir());

const absolute = (value: string, cwd: string) =>
  resolve(
    cwd,
    value === "~" ? homedir() : value.startsWith("~/") ? join(homedir(), value.slice(2)) : value,
  );

/** Any rewrite of a settings file changes its inode, size or nanosecond modification time. */
const settingsFileVersion = (path: string) => {
  try {
    const { ino, size, mtimeNs } = statSync(path, { bigint: true });
    return `${ino}:${size}:${mtimeNs}`;
  } catch {
    return "absent";
  }
};

const configuredSessionDirectories = new Map<
  string,
  { readonly version: string; readonly sessionDir: string | undefined }
>();

/** Routing runs for every stored session, so parse Pi settings (under Pi's file lock) only
 * after one of the two settings files changes, not on every lookup. */
function configuredSessionDirectory(cwd: string, agentDir: string) {
  const key = `${agentDir}\0${resolve(cwd)}`;
  const version = [
    join(agentDir, "settings.json"),
    join(resolve(cwd), CONFIG_DIR_NAME, "settings.json"),
  ]
    .map(settingsFileVersion)
    .join("|");
  const cached = configuredSessionDirectories.get(key);
  if (cached?.version === version) return cached.sessionDir;
  // Like Pi CLI's startup selector, read project routing before runtime trust.
  // SettingsManager only reads configuration; no resource loader runs here.
  const sessionDir = SettingsManager.create(cwd, agentDir).getSessionDir();
  configuredSessionDirectories.set(key, { version, sessionDir });
  return sessionDir;
}

/** Read-only session routing, matching Pi CLI precedence before project trust. */
export function piProjectSessionDirectory(cwd: string, root: string) {
  const agentDir = piAgentDirectory();
  if (resolve(root) === join(agentDir, "sessions")) {
    const configured =
      process.env.PI_CODING_AGENT_SESSION_DIR || configuredSessionDirectory(cwd, agentDir);
    if (configured) return { directory: absolute(configured, cwd), shared: true };
  }
  // Pi does not export its directory encoder from the public SDK.
  const normalized = resolve(cwd);
  const encoded = `--${normalized.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  return { directory: join(resolve(root), encoded), shared: false };
}

/** One SDK-owned discovery pass; the ID set lives only for this enumeration. */
export async function piSessionIdsForWorkingDirectory(
  cwd: string,
  directory: string,
  signal: AbortSignal,
): Promise<ReadonlySet<string>> {
  // The public list API owns cwd normalization and malformed-session handling.
  // It reads bodies asynchronously with bounded concurrency; Cake keeps only IDs.
  const sessions = await SessionManager.list(cwd, directory, undefined, signal);
  return new Set(sessions.map((session) => session.id));
}

/** Pi's public lookup filters custom directories by the session header's cwd. */
export function piSessionMatchesWorkingDirectory(
  cwd: string,
  sessionId: string,
  directory: string,
) {
  return SessionManager.findById(cwd, sessionId, directory) !== undefined;
}
