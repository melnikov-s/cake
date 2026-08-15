import { Store, observable } from "r-state-tree";
import type { DesktopClientEvent } from "../desktop-client";
import type { SessionOperationCoordinator } from "./SessionOperationCoordinator";

/** Owns operation correlation initiated by global Cake controls. */
export class AppControlOperationStore extends Store<{ operations: SessionOperationCoordinator }> {
  private readonly activeOperations: string[] = observable([]);

  async run(action: (operationId: string) => Promise<void>) {
    const operationId = this.props.operations.start();
    this.activeOperations.push(operationId);
    try {
      await action(operationId);
    } catch (error) {
      this.finish(operationId);
      throw error;
    }
  }

  receive(event: DesktopClientEvent) {
    if (event.type === "pi-state-changed" && (event.state === "failed" || event.state === "stopped")) {
      for (const operationId of this.activeOperations.slice()) this.finish(operationId);
      return;
    }
    if ((event.type === "operation-completed" || event.type === "operation-failed") && event.operationId && this.activeOperations.includes(event.operationId)) {
      this.finish(event.operationId);
    }
  }

  private finish(operationId: string) {
    const index = this.activeOperations.indexOf(operationId);
    if (index >= 0) this.activeOperations.splice(index, 1);
    this.props.operations.finish(operationId);
  }
}
