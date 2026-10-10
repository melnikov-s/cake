import { Store } from "r-state-tree";
import { submitNativeMcpAction } from "../lib/native-mcp-action";
import type {
  McpEntry,
  McpSettingsSnapshot,
  McpSettingsMutation,
} from "../../services/pi/mcp-settings-data";
import { ClientContext } from "./context/ClientContext";
import { describeError } from "../lib/error-details";
import { parseMcpObject, readMcpDraft } from "../lib/mcp-config-draft";
import type { ProjectSessionStore } from "./ProjectSessionStore";

/** Window-lifetime Settings drafts. Pi files are authoritative; mutations serialize with CAS. */
export class McpSettingsStore extends Store<{ projectSession(): ProjectSessionStore | undefined }> {
  projectScope = false;
  snapshot: McpSettingsSnapshot | undefined;
  busy = false;
  error: string | undefined;
  notice: string | undefined;
  editing = false;
  existing = false;
  name = "";
  transport = "stdio";
  endpoint = "";
  args = "";
  cwd = "";
  env = "{}";
  description = "";
  exposure = "codemode";
  enabled = true;
  advanced = "{}";
  private request = 0;
  private authSessionId: string | undefined;
  get client() {
    return ClientContext.consume(this)!;
  }
  get projectSession() {
    return this.props.projectSession();
  }
  get projectPath() {
    return this.projectSession?.workspacePath;
  }
  get scope() {
    return this.projectScope && this.projectPath ? { projectPath: this.projectPath } : {};
  }
  get scopeMatches() {
    return !!this.snapshot && this.snapshot.scope.projectPath === this.scope.projectPath;
  }
  get entries() {
    return this.scopeMatches ? (this.snapshot?.entries ?? []) : [];
  }
  get nativeActionsAvailable() {
    return (
      this.projectScope &&
      this.snapshot?.scope.projectPath === this.projectPath &&
      !!this.projectSession?.model.commands.some(
        (command) => command.name === "mcp" && command.sourceInfo.path === "builtin:mcp",
      ) &&
      !this.projectSession.isStreaming &&
      this.projectSession.model.activeTurnIds.length === 0
    );
  }
  get authenticating() {
    return this.authSessionId !== undefined;
  }
  async load(revealSecrets = false) {
    if (this.busy || this.authenticating) return;
    const request = ++this.request;
    this.busy = true;
    this.error = undefined;
    this.editing = false;
    try {
      const value = await this.client.mcpSettings.get(
        { ...this.scope, revealSecrets },
        { signal: this.signal },
      );
      if (!this.signal.aborted && request === this.request) this.snapshot = value;
    } catch (error) {
      if (!this.signal.aborted) this.error = describeError(error).message;
    } finally {
      if (!this.signal.aborted && request === this.request) this.busy = false;
    }
  }
  async selectScope(project: boolean) {
    if (this.busy || this.authenticating) return;
    this.projectScope = project;
    this.snapshot = undefined;
    this.notice = undefined;
    await this.load();
  }
  add() {
    if (this.busy) return;
    this.editing = true;
    this.existing = false;
    this.name = "";
    this.transport = "stdio";
    this.endpoint = "";
    this.args = "";
    this.cwd = "";
    this.env = "{}";
    this.description = "";
    this.exposure = "codemode";
    this.enabled = true;
    this.advanced = "{}";
  }
  edit(entry: McpEntry) {
    if (this.busy) return;
    const draft = readMcpDraft(entry.config);
    this.editing = true;
    this.existing = entry.scope === (this.projectScope ? "project" : "backend");
    this.name = entry.name;
    this.transport = draft.transport;
    this.endpoint = draft.endpoint;
    this.args = draft.args;
    this.cwd = draft.cwd;
    this.env = draft.env;
    this.description = draft.description;
    this.exposure = draft.exposure;
    this.enabled = draft.enabled;
    this.advanced = draft.advanced;
  }
  cancelEdit() {
    this.editing = false;
  }
  async save() {
    try {
      const extra = parseMcpObject(this.advanced);
      const config = {
        ...extra,
        ...(this.transport === "stdio"
          ? {
              command: this.endpoint,
              args: this.args ? this.args.split("\n") : [],
              env: parseMcpObject(this.env),
              ...(this.cwd ? { cwd: this.cwd } : undefined),
            }
          : { url: this.endpoint }),
        description: this.description,
        exposure: this.exposure,
        enabled: this.enabled,
      };
      await this.mutate(this.name, "save", config);
    } catch {
      this.error = "Invalid JSON in environment or advanced configuration. Use JSON objects.";
    }
  }
  async mutate(
    name: string,
    action: McpSettingsMutation["action"],
    config?: McpSettingsMutation["config"],
  ) {
    if (this.busy || !this.snapshot || this.authenticating) return;
    if (!this.scopeMatches) {
      this.error = "The current Project changed. Refresh MCP settings before saving.";
      return;
    }
    this.busy = true;
    this.error = undefined;
    this.notice = undefined;
    try {
      const value = await this.client.mcpSettings.mutate(
        {
          ...this.scope,
          revision: this.snapshot.revision,
          name,
          action,
          ...(config ? { config } : undefined),
        },
        { signal: this.signal },
      );
      if (this.signal.aborted) return;
      this.snapshot = value;
      this.editing = false;
      this.notice = "Saved on the backend. Pi reload applied or queued for busy sessions.";
    } catch (error) {
      if (!this.signal.aborted) this.error = describeError(error).message;
    } finally {
      if (!this.signal.aborted) this.busy = false;
    }
  }
  async nativeAction(name: string, action: "login" | "logout" | "reconnect") {
    const session = this.projectSession;
    if (
      !session ||
      !this.nativeActionsAvailable ||
      this.authenticating ||
      this.busy ||
      !/^[A-Za-z0-9_-]+$/.test(name)
    )
      return;
    this.authSessionId = session.sessionId;
    this.error = undefined;
    try {
      await submitNativeMcpAction(this.client, session, name, action, this.signal);
      this.notice =
        "Native Pi command submitted. Follow its dialogs and current session notices; stored config is not live status.";
    } catch (error) {
      if (!this.signal.aborted) this.error = describeError(error).message;
    } finally {
      if (!this.signal.aborted) this.authSessionId = undefined;
    }
  }
}
