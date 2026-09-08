import { Model, id } from "r-state-tree";

/** Shared provider/model identity. Runtime availability belongs to session model options. */
export class LlmModel extends Model {
  @id id = "";
  provider = "";
  modelId = "";
  name = "";
}
