import { Model, id } from "r-state-tree";
import type { CompatibilityResource } from "../../contracts/conversations/session-contract";

/** Shared identity of a discovered skill, prompt, extension, or package. */
export class Resource extends Model {
  @id id = "";
  kind: CompatibilityResource["kind"] = "extension";
  path: string | undefined;
}
