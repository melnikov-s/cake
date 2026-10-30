import { Store } from "r-state-tree";
import { defaultLocalMcpConfiguration, type LocalMcpSnapshot } from "../../contracts/mcp/local-mcp";
import { ClientContext } from "./context/ClientContext";
import { describeError } from "../lib/error-details";

export class LocalMcpSettingsStore extends Store {
  snapshot: LocalMcpSnapshot | undefined;
  port = String(defaultLocalMcpConfiguration().port);
  busy = false;
  error: string | undefined;

  private apply(snapshot: LocalMcpSnapshot) {
    this.snapshot = snapshot;
    this.port = String(snapshot.configuration.port);
  }
  reportCopyError() {
    this.error = "Could not copy MCP configuration.";
  }
  setPort(value: string) {
    this.port = value;
  }
  async load() {
    if (this.busy) return;
    this.busy = true;
    this.error = undefined;
    try {
      this.apply(
        await ClientContext.consume(this)!.mcpSettings.serverGet({}, { signal: this.signal }),
      );
    } catch (cause) {
      if (!this.signal.aborted) this.error = describeError(cause).message;
    } finally {
      if (!this.signal.aborted) this.busy = false;
    }
  }
  async save(enabled = this.snapshot?.configuration.enabled ?? false) {
    if (this.busy) return;
    this.busy = true;
    this.error = undefined;
    try {
      const validPort = /^\d+$/.test(this.port) && Number(this.port) <= 65535;
      if (enabled && !validPort) throw new Error("Port must be an integer from 0 to 65535.");
      const configuration = {
        enabled,
        port: validPort
          ? Number(this.port)
          : (this.snapshot?.configuration.port ?? defaultLocalMcpConfiguration().port),
      };
      this.apply(
        await ClientContext.consume(this)!.mcpSettings.serverConfigure(configuration, {
          signal: this.signal,
        }),
      );
    } catch (cause) {
      if (!this.signal.aborted) this.error = describeError(cause).message;
    } finally {
      if (!this.signal.aborted) this.busy = false;
    }
  }
  async rotateToken() {
    if (this.busy) return;
    this.busy = true;
    this.error = undefined;
    try {
      this.apply(
        await ClientContext.consume(this)!.mcpSettings.serverRotateToken(
          {},
          { signal: this.signal },
        ),
      );
    } catch (cause) {
      if (!this.signal.aborted) this.error = describeError(cause).message;
    } finally {
      if (!this.signal.aborted) this.busy = false;
    }
  }
}
