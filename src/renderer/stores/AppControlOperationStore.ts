import { Store } from "r-state-tree";
import type { SessionOperationCoordinatorStore } from "./SessionOperationCoordinatorStore";

/** Owns renderer-local progress for commands initiated by Cake application controls. */
export class AppControlOperationStore extends Store<{
  operations: SessionOperationCoordinatorStore;
}> {
  async run(action: (operationId: string) => Promise<void>) {
    const operationId = this.props.operations.start("app-control");
    try {
      await action(operationId);
    } finally {
      this.props.operations.finish(operationId);
    }
  }
}
