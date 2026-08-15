import { Store, observable } from "r-state-tree";

/** Correlates runtime operation ids with session-scoped UI/artifact events. */
export class SessionOperationCoordinator extends Store<Record<string, never>> {
  private readonly operationIds: string[] = observable([]);

  start() {
    const operationId = crypto.randomUUID();
    this.operationIds.push(operationId);
    return operationId;
  }

  finish(operationId: string) {
    const index = this.operationIds.indexOf(operationId);
    if (index >= 0) this.operationIds.splice(index, 1);
  }

  includes(operationId: string) {
    return this.operationIds.includes(operationId);
  }

  reset() {
    this.operationIds.splice(0);
  }
}
