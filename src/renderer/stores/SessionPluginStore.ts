import { Store, observable } from "r-state-tree";
import type {
  ApplicationState,
  SessionPlugin,
  SessionPluginSharedState,
} from "../../domain/application/application-data";
import type { JsonValue } from "../../ipc/json-contract";
import { ClientContext } from "./context/ClientContext";

/** Window projection and mutation boundary for durable session-bound plugins. */
export class SessionPluginStore extends Store {
  private revision = -1;
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
