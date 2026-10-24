import { Store } from "r-state-tree";
import {
  decodeDesktopSharingInput,
  decodeDesktopSharingPreferences,
  type DesktopSharingInput,
  type DesktopSharingPreferences,
  type DesktopSharingState,
} from "../../contracts/desktop/desktop-sharing-data";
import { ClientContext } from "./context/ClientContext";
import { describeError } from "../lib/error-details";

/** Device-local preferences are main-owned; only drafts and listener activity are transient. */
export class DesktopSharingSettingsStore extends Store {
  state: DesktopSharingState | undefined;
  bind = "127.0.0.1";
  port = "4317";
  publicOrigin = "";
  busy = false;
  saving = false;
  error: string | undefined;
  private editRevision = 0;
  private pendingSaves = 0;
  private dirty = false;

  private hydrate(preferences: DesktopSharingPreferences) {
    this.bind = preferences.bind;
    this.port = String(preferences.port);
    this.publicOrigin = preferences.publicOrigin ?? "";
  }
  apply(state: DesktopSharingState) {
    this.state = state;
    if (!this.busy && !this.saving && !this.dirty) this.hydrate(state.preferences);
  }
  get enabled() {
    return this.state?.status === "serving";
  }
  get pending() {
    return (
      this.busy ||
      !this.state ||
      this.state.status === "starting" ||
      this.state.status === "stopping"
    );
  }
  setBind(value: string) {
    if (this.enabled || this.pending) return;
    this.bind = value;
    void this.savePreferences();
  }
  setPort(value: string) {
    if (this.enabled || this.pending) return;
    this.port = value;
    void this.savePreferences();
  }
  setPublicOrigin(value: string) {
    if (this.enabled || this.pending) return;
    this.publicOrigin = value;
    void this.savePreferences();
  }
  private draft(): DesktopSharingPreferences | undefined {
    if (!/^\d+$/.test(this.port)) return;
    const preferences: DesktopSharingPreferences = {
      bind: this.bind.trim(),
      port: Number(this.port),
    };
    if (this.publicOrigin.trim())
      Object.assign(preferences, { publicOrigin: this.publicOrigin.trim() });
    const decoded = decodeDesktopSharingPreferences(preferences);
    return decoded._tag === "Success" ? decoded.success : undefined;
  }
  private async savePreferences() {
    const edit = ++this.editRevision;
    this.dirty = true;
    const preferences = this.draft();
    if (!preferences) return; // Incomplete/invalid text is a draft, not a committed setting.
    ++this.pendingSaves;
    this.saving = true;
    this.error = undefined;
    try {
      // Dispatch immediately, without a renderer debounce/queue that could be lost on close.
      // Main serializes and finishes accepted writes independently of request cancellation.
      const state = await ClientContext.consume(this)!.desktopSharing.updatePreferences(
        preferences,
        { signal: this.signal },
      );
      if (!this.signal.aborted && edit === this.editRevision) {
        this.dirty = false;
        this.hydrate(state.preferences);
      }
    } catch (error) {
      if (!this.signal.aborted && edit === this.editRevision)
        this.error = describeError(error).message;
    } finally {
      --this.pendingSaves;
      if (!this.signal.aborted) this.saving = this.pendingSaves > 0;
    }
  }
  async configure(enabled: boolean, preferences?: DesktopSharingPreferences) {
    if (this.pending) return;
    if (preferences) this.hydrate(preferences);
    ++this.editRevision;
    this.busy = true;
    this.error = undefined;
    try {
      if (!/^\d+$/.test(this.port)) throw new Error("Port must be an integer from 0 to 65535.");
      const input: DesktopSharingInput = {
        enabled,
        bind: this.bind.trim(),
        port: Number(this.port),
      };
      if (this.publicOrigin.trim())
        Object.assign(input, { publicOrigin: this.publicOrigin.trim() });
      const decoded = decodeDesktopSharingInput(input);
      if (decoded._tag === "Failure") throw new Error(decoded.failure.message);
      const state = await ClientContext.consume(this)!.desktopSharing.configure(decoded.success, {
        signal: this.signal,
      });
      if (!this.signal.aborted) {
        this.state = state;
        this.dirty = false;
        this.hydrate(state.preferences);
      }
      return state;
    } catch (error) {
      if (!this.signal.aborted) this.error = describeError(error).message;
    } finally {
      if (!this.signal.aborted) {
        this.busy = false;
        this.saving = this.pendingSaves > 0;
      }
    }
  }
}
