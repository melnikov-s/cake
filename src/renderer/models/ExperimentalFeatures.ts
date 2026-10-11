import { Model } from "r-state-tree";

/** Window-scoped projection of main-owned feature availability; never locally persisted. */
export class ExperimentalFeatures extends Model {
  revision = -1;
  dynamicWorkflows = false;
}
