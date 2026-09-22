import { Store, observable } from "r-state-tree";
import type {
  ApplicationState,
  SessionPlugin,
  SessionPluginSharedState,
} from "../../domain/application/application-data";
import type { JsonObject, JsonValue } from "../../ipc/json-contract";
import { ClientContext } from "./context/ClientContext";

/** Window projection and mutation boundary for durable session-bound plugins. */
export class SessionPluginStore extends Store {
  private revision = -1;
  // Window-local dispatch status, never persisted. One in-flight action per plugin;
  // visibility is independent so the user can always hide a busy contribution.
  readonly pendingActions = observable(new Set<string>());
  readonly pendingVisibility = observable(new Set<string>());
  readonly errors = observable(new Map<string, string>());

  statusKey(sessionId: string, pluginId: string) {
    return JSON.stringify([sessionId, pluginId]);
  }

  async sendAction(
    sessionId: string,
    pluginId: string,
    actionId: string,
    call: (command: string, input: JsonObject) => Promise<JsonValue>,
  ) {
    const key = this.statusKey(sessionId, pluginId);
    const plugin = this.plugins.find(
      (entry) => entry.sessionId === sessionId && entry.id === pluginId,
    );
    if (!plugin || plugin.hidden || !("preset" in plugin) || this.pendingActions.has(key)) return;
    const action = plugin.state.actions.find((entry) => entry.id === actionId);
    if (!action || action.disabled) return;
    this.pendingActions.add(key);
    this.errors.delete(key);
    try {
      await call("session.prompt", { text: action.message });
    } catch (error) {
      this.errors.set(key, error instanceof Error ? error.message : String(error));
    } finally {
      this.pendingActions.delete(key);
    }
  }

  async setHidden(sessionId: string, pluginId: string, hidden: boolean) {
    const key = this.statusKey(sessionId, pluginId);
    if (this.pendingVisibility.has(key)) return;
    this.pendingVisibility.add(key);
    this.errors.delete(key);
    try {
      await this.client.application.setSessionPluginHidden(
        { sessionId, pluginId, hidden },
        { signal: this.signal },
      );
    } catch (error) {
      this.errors.set(key, error instanceof Error ? error.message : String(error));
    } finally {
      this.pendingVisibility.delete(key);
    }
  }
  readonly plugins: SessionPlugin[] = observable([]);
  readonly sharedState: SessionPluginSharedState[] = observable([]);

  get client() {
    return ClientContext.consume(this)!;
  }

  applyApplicationState(revision: number, state: ApplicationState) {
    if (revision < this.revision) return;
    this.revision = revision;
    this.plugins.splice(
      0,
      this.plugins.length,
      ...state.sessionPlugins.map((plugin) => ({ ...plugin })),
    );
    this.sharedState.splice(
      0,
      this.sharedState.length,
      ...state.sessionPluginSharedState.map((entry) => ({ ...entry })),
    );
  }

  forSession(sessionId: string) {
    return this.plugins.filter((plugin) => plugin.sessionId === sessionId);
  }

  shared(sessionId: string) {
    return this.sharedState
      .filter((entry) => entry.sessionId === sessionId)
      .reduce<Record<string, JsonValue>>((result, entry) => {
        result[entry.key] = entry.value;
        return result;
      }, {});
  }

  async setPluginState(sessionId: string, pluginId: string, state: JsonValue) {
    await this.client.application.setSessionPluginState(
      { sessionId, pluginId, state },
      { signal: this.signal },
    );
  }

  async setSharedState(sessionId: string, key: string, value: JsonValue) {
    await this.client.application.setSessionPluginSharedState(
      { sessionId, key, value },
      { signal: this.signal },
    );
  }

  async delete(sessionId: string, pluginId: string) {
    await this.client.application.deleteSessionPlugin(
      { sessionId, pluginId },
      { signal: this.signal },
    );
  }
}
