import { Model, id, observable } from "r-state-tree";
import type { CompatibilityResource as CompatibilityResourceRecord } from "../../ipc/session-contract";

export class CompatibilityResource extends Model {
  @id id = "";
  kind: CompatibilityResourceRecord["kind"] = "extension";
  name = "";
  description: string | undefined;
  path: string | undefined;
  source = "";
  scope: CompatibilityResourceRecord["scope"] = "user";
  origin: CompatibilityResourceRecord["origin"] = "top-level";
  commands: string[] = observable([]);
  tools: string[] = observable([]);
  enabled = true;

  get value(): CompatibilityResourceRecord {
    return {
      id: this.id,
      kind: this.kind,
      name: this.name,
      description: this.description,
      path: this.path,
      source: this.source,
      scope: this.scope,
      origin: this.origin,
      commands: this.commands.slice(),
      tools: this.tools.slice(),
      enabled: this.enabled,
    };
  }
}
