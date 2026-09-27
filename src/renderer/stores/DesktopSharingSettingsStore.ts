import { Store } from "r-state-tree";
import type { DesktopSharingState } from "../../domain/application/desktop-sharing-data";
import { ClientContext } from "./context/ClientContext";
import { describeError } from "../lib/error-details";

/** Window-owned, nonpersisted settings workflow. Main owns serving state; commands single-flight. */
export class DesktopSharingSettingsStore extends Store {
  state: DesktopSharingState | undefined;
  bind = "127.0.0.1";
  port = "4317";
  busy = false;
  error: string | undefined;
  apply(state: DesktopSharingState) {
    this.state = state;
    if (state.status === "serving") {
      this.bind = state.bind;
      this.port = String(state.port);
    }
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
    if (!this.enabled && !this.pending) this.bind = value;
  }
  setPort(value: string) {
    if (!this.enabled && !this.pending) this.port = value;
  }
  async configure(enabled: boolean) {
    if (this.pending) return;
    this.busy = true;
    this.error = undefined;
    try {
      if (!/^\d+$/.test(this.port)) throw new Error("Port must be an integer from 0 to 65535.");
      await ClientContext.consume(this)!.desktopSharing.configure(
        { enabled, bind: this.bind.trim(), port: Number(this.port) },
        { signal: this.signal },
      );
    } catch (error) {
      if (!this.signal.aborted) this.error = describeError(error).message;
    } finally {
      if (!this.signal.aborted) this.busy = false;
    }
  }
}
