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
  googleEnabled = false;
  googleSetupOpen = false;
  googleClientId = "";
  allowedEmails = "";
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
    this.googleEnabled = preferences.google !== undefined;
    this.googleClientId = preferences.google?.clientId ?? "";
    this.allowedEmails = preferences.google?.allowedEmails.join("\n") ?? "";
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
  toggleGoogleSetup() {
    this.googleSetupOpen = !this.googleSetupOpen;
  }
  setGoogleEnabled(value: boolean) {
    if (this.enabled || this.pending) return;
    this.googleEnabled = value;
    this.dirty = true;
  }
  setGoogleClientId(value: string) {
    if (this.enabled || this.pending) return;
    this.googleClientId = value;
    this.dirty = true;
  }
  setAllowedEmails(value: string) {
    this.allowedEmails = value;
    this.dirty = true;
  }
  async saveGooglePreferences() {
    const draft = this.draft();
    if (draft._tag === "Failure") {
      this.error = draft.failure.message;
      return;
    }
    await this.savePreferences();
  }
  private draft() {
    const preferences: DesktopSharingPreferences = {
      bind: this.bind.trim(),
      port: /^\d+$/.test(this.port) ? Number(this.port) : Number.NaN,
    };
    if (this.publicOrigin.trim())
      Object.assign(preferences, { publicOrigin: this.publicOrigin.trim() });
    if (this.googleEnabled) {
      Object.assign(preferences, {
        google: {
          clientId: this.googleClientId.trim(),
          allowedEmails: [
            ...new Set(
              this.allowedEmails
                .split(/[\n,]/)
                .map((email) => email.trim().toLowerCase())
                .filter(Boolean),
            ),
          ],
        },
      });
    }
    return decodeDesktopSharingPreferences(preferences);
  }
  private async savePreferences() {
    const edit = ++this.editRevision;
    this.dirty = true;
    const draft = this.draft();
    if (draft._tag === "Failure") return; // Incomplete/invalid text is a draft, not a committed setting.
    const preferences = draft.success;
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
        this.state = state;
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
      if (enabled && !/^\d+$/.test(this.port))
        throw new Error("Port must be an integer from 0 to 65535.");
      const draft = enabled ? this.draft() : undefined;
      if (draft?._tag === "Failure") throw new Error(draft.failure.message);
      // Switching off must remain possible even with an incomplete local draft.
      const preferences = draft?._tag === "Success" ? draft.success : this.state?.preferences;
      if (!preferences)
        throw new Error("Complete the connection and Google sign-in settings first.");
      const input: DesktopSharingInput = { ...preferences, enabled };
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
