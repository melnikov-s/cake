import { Model, id, observable, state } from "r-state-tree";
import type { SessionTreeNode } from "../../ipc/session-contract";

export class SessionTreeNodeModel extends Model {
  @id id = "";
  @state parentId: string | undefined;
  @state type = "";
  @state label: string | undefined;
  @state preview = "";
  @state active = false;
  @state children: SessionTreeNode[] = observable([]);
}
