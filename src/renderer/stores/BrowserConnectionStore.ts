import { Store } from "r-state-tree";

/** Tab-owned connection and uncertain-delivery policy; never persisted or replayed. */
export class BrowserConnectionStore extends Store<{ initialUncertainOperation?: string }> {
  connected = false;
  everConnected = false;
  uncertainOperation: string | undefined;

  constructor(props: BrowserConnectionStore["props"]) {
    super(props);
    this.uncertainOperation = props.initialUncertainOperation;
  }

  connectionChanged(connected: boolean) {
    this.connected = connected;
    if (connected) this.everConnected = true;
  }

  deliveryUncertain(operation: string) {
    this.uncertainOperation ??= operation;
  }

  acknowledgeUncertainty() {
    if (this.connected) this.uncertainOperation = undefined;
  }
}
