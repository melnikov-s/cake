import { Store, observable } from "r-state-tree";
import type { CustomizationState, PluginStatus } from "../../plugin/plugin-contract";
import { RendererClientContext } from "../client/RendererClientContext";
import type { RendererEvent } from "../RendererEvent";

/** Owns customization diagnostics, candidate builds, rollback, and recovery. */
export class CustomizationStore extends Store {
  state?: CustomizationState;
  busy = false;
  error?: string;
  plugins: PluginStatus[] = observable([]);
  private hydration: Promise<void> | undefined;

  get pluginCommands() {
    return RendererClientContext.consume(this)!.plugins;
  }

  hydrate() {
    this.hydration ??= this.performHydration();
    return this.hydration;
  }

  private async performHydration() {
    try {
      const [state, plugins] = await Promise.all([
        this.pluginCommands.getCustomizationState({ signal: this.signal }),
        this.pluginCommands.list({ signal: this.signal }),
      ]);
      if (this.signal.aborted) return;
      this.state = state;
      this.plugins.splice(0, this.plugins.length, ...plugins);
    } catch (error) {
      if (this.signal.aborted) return;
      this.error = error instanceof Error ? error.message : String(error);
    }
  }

  receive(event: RendererEvent) {
    if (event.type === "customization-state-changed") this.state = event.state;
  }

  async rebuild() {
    if (this.busy) return;
    this.busy = true;
    this.error = undefined;
    try {
      const result = await this.pluginCommands.validate(
        this.state?.sourceRevision,
        "Rebuild customization from the recovery interface",
      );
      if (this.signal.aborted) return;
      if (result.diagnostics.length)
        this.error = "The customization candidate did not pass its checks.";
      else
        await this.pluginCommands.activate(
          result.revision,
          result.sourceRevision,
          "Activate customization from the recovery interface",
        );
    } catch (error) {
      if (this.signal.aborted) return;
      this.error = error instanceof Error ? error.message : String(error);
    } finally {
      if (!this.signal.aborted) this.busy = false;
    }
  }

  async rollback() {
    if (this.busy) return;
    this.busy = true;
    try {
      const state = await this.pluginCommands.rollback({ signal: this.signal });
      if (!this.signal.aborted) this.state = state;
    } catch (error) {
      if (this.signal.aborted) return;
      this.error = error instanceof Error ? error.message : String(error);
    } finally {
      if (!this.signal.aborted) this.busy = false;
    }
  }

  async useFactory() {
    if (this.busy) return;
    this.busy = true;
    try {
      const state = await this.pluginCommands.useFactory({ signal: this.signal });
      if (!this.signal.aborted) this.state = state;
    } catch (error) {
      if (this.signal.aborted) return;
      this.error = error instanceof Error ? error.message : String(error);
    } finally {
      if (!this.signal.aborted) this.busy = false;
    }
  }

  async setPluginEnabled(pluginId: string, enabled: boolean) {
    if (this.busy) return;
    this.busy = true;
    this.error = undefined;
    try {
      const plugins = await this.pluginCommands.setEnabled(pluginId, enabled, {
        signal: this.signal,
      });
      if (this.signal.aborted) return;
      this.plugins.splice(0, this.plugins.length, ...plugins);
    } catch (error) {
      if (this.signal.aborted) return;
      this.error = error instanceof Error ? error.message : String(error);
    } finally {
      if (!this.signal.aborted) this.busy = false;
    }
  }

  async setActiveScene(pluginId?: string) {
    if (this.busy) return;
    this.busy = true;
    this.error = undefined;
    try {
      const plugins = await this.pluginCommands.setActiveScene(pluginId, { signal: this.signal });
      if (this.signal.aborted) return;
      this.plugins.splice(0, this.plugins.length, ...plugins);
    } catch (error) {
      if (this.signal.aborted) return;
      this.error = error instanceof Error ? error.message : String(error);
    } finally {
      if (!this.signal.aborted) this.busy = false;
    }
  }

  async deletePlugin(pluginId: string) {
    if (this.busy) return;
    this.busy = true;
    this.error = undefined;
    try {
      const plugins = await this.pluginCommands.delete(pluginId, { signal: this.signal });
      if (this.signal.aborted) return;
      this.plugins.splice(0, this.plugins.length, ...plugins);
    } catch (error) {
      if (this.signal.aborted) return;
      this.error = error instanceof Error ? error.message : String(error);
    } finally {
      if (!this.signal.aborted) this.busy = false;
    }
  }
}
