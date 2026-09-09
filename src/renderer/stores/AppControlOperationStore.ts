import { Store } from "r-state-tree";
import type { SessionOperationCoordinatorStore } from "./SessionOperationCoordinatorStore";

/** Owns renderer-local progress for commands initiated by Cake application controls. */
export class AppControlOperationStore extends Store<{
  operations: Pick<SessionOperationCoordinatorStore, "finish" | "start">;
}> {
  async run<A>(action: (operationId: string) => Promise<A>): Promise<A> {
    const operationId = this.props.operations.start("app-control");
    try {
      return await action(operationId);
    } finally {
      this.props.operations.finish(operationId);
    }
  }
}
