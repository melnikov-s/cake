import { Store, observable } from "r-state-tree";

/** Correlates runtime operation ids with session-scoped UI/artifact events. */
export class SessionOperationCoordinator extends Store<Record<string, never>> {
  private readonly operations: Array<{ id: string; owner: string }> = observable([]);

  start(owner = "shared") {
    const operationId = crypto.randomUUID();
    this.operations.push({ id: operationId, owner });
    return operationId;
  }

  finish(operationId: string) {
    const index = this.operations.findIndex((operation) => operation.id === operationId);
    if (index >= 0) this.operations.splice(index, 1);
  }

  includes(operationId: string, owner?: string) {
    return this.operations.some(
      (operation) => operation.id === operationId && (!owner || operation.owner === owner),
    );
  }

  active(owner?: string) {
    return this.operations
      .filter((operation) => !owner || operation.owner === owner)
      .map((operation) => operation.id);
  }

  reset(owner?: string) {
    if (!owner) this.operations.splice(0);
    else
      for (let index = this.operations.length - 1; index >= 0; index -= 1) {
        if (this.operations[index]!.owner === owner) this.operations.splice(index, 1);
      }
  }
}
