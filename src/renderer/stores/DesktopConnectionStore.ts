import { Store } from "r-state-tree";
import type { DesktopHostSelection } from "../../domain/application/desktop-host-data";
import { normalizeServerUrl } from "../../domain/application/desktop-host-data";
import type { Client } from "../client/Client";

/** Window-lifetime host workflow; saved selection is native-owned, connection facts are projected.
 * Commands are single-flight. No connection/delivery state is in a window snapshot. */
export class DesktopConnectionStore extends Store<{
  host: DesktopHostSelection;
  client(): Client;
  connect(): Promise<void>;
}> {
  url = "";
  connected = false;
  connecting = false;
  selecting = false;
  error: string | undefined;
  uncertainOperation: string | undefined;
  constructor(props: DesktopConnectionStore["props"]) {
    super(props);
    this.url = props.host.kind === "remote" ? props.host.url : "http://127.0.0.1:4317";
    this.connected = props.host.kind === "local";
  }
  get remote() {
    return this.props.host.kind === "remote";
  }
  get hostLabel() {
    return this.props.host.kind === "remote" ? this.props.host.url : "This computer";
  }
  setUrl(value: string) {
    this.url = value;
  }
  connectionChanged(connected: boolean) {
    this.connected = connected;
    if (connected) this.error = undefined;
  }
  deliveryUncertain(operation: string) {
    this.uncertainOperation = operation;
  }
  acknowledgeUncertainty() {
    if (this.connected) this.uncertainOperation = undefined;
  }
  async retry() {
    if (this.connecting) return;
    this.connecting = true;
    this.error = undefined;
    try {
      await this.props.connect();
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    } finally {
      this.connecting = false;
    }
  }
  async selectRemote() {
    try {
      await this.select({ kind: "remote", url: normalizeServerUrl(this.url) });
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    }
  }
  async selectLocal() {
    await this.select({ kind: "local" });
  }
  private async select(host: DesktopHostSelection) {
    if (this.selecting) return;
    this.selecting = true;
    this.error = undefined;
    try {
      await this.props.client().desktopHost.select(host, { signal: this.signal });
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    } finally {
      this.selecting = false;
    }
  }
}
