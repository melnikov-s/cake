import { Store } from "r-state-tree";
import type { DesktopClientEvent } from "../desktop-client";
import type { SessionOperationCoordinatorStore } from "./SessionOperationCoordinatorStore";

/** Owns operation correlation initiated by global Cake controls. */
export class AppControlOperationStore extends Store<{
  operations: SessionOperationCoordinatorStore;
}> {
  async run(action: (operationId: string) => Promise<void>) {
    const operationId = this.props.operations.start("app-control");
    try {
      await action(operationId);
    } catch (error) {
      this.finish(operationId);
      throw error;
    }
  }

  receive(event: DesktopClientEvent) {
    if (
      event.type === "pi-state-changed" &&
      (event.state === "failed" || event.state === "stopped")
    ) {
      this.props.operations.reset("app-control");
      return;
    }
    if (
      (event.type === "operation-completed" || event.type === "operation-failed") &&
      event.operationId &&
      this.props.operations.includes(event.operationId, "app-control")
    ) {
      this.finish(event.operationId);
    }
  }

  private finish(operationId: string) {
    this.props.operations.finish(operationId);
  }
}
