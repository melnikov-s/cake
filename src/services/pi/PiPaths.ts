import { getAgentDir, SettingsManager, SessionManager } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** Pi resolves its own agent home. Cake must never overwrite its process environment. */
export const piAgentDirectory = () => resolve(getAgentDir());

const absolute = (value: string, cwd: string) =>
  resolve(
    cwd,
    value === "~" ? homedir() : value.startsWith("~/") ? join(homedir(), value.slice(2)) : value,
  );

/** Read-only session routing, matching Pi CLI precedence before project trust. */
export function piProjectSessionDirectory(cwd: string, root: string) {
  const agentDir = piAgentDirectory();
  if (resolve(root) === join(agentDir, "sessions")) {
    const configured =
      process.env.PI_CODING_AGENT_SESSION_DIR ||
      // Like Pi CLI's startup selector, read project routing before runtime trust.
      // SettingsManager only reads configuration; no resource loader runs here.
      SettingsManager.create(cwd, agentDir).getSessionDir();
    if (configured) return { directory: absolute(configured, cwd), shared: true };
  }
  // Pi does not export its directory encoder from the public SDK.
  const normalized = resolve(cwd);
  const encoded = `--${normalized.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  return { directory: join(resolve(root), encoded), shared: false };
}

/** Pi's public lookup filters custom directories by the session header's cwd. */
export function piSessionMatchesWorkingDirectory(
  cwd: string,
  sessionId: string,
  directory: string,
) {
  return SessionManager.findById(cwd, sessionId, directory) !== undefined;
}
