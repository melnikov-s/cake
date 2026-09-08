import { Model, id, modelRef, observable } from "r-state-tree";
import type { CompatibilityResource as CompatibilityResourceRecord } from "../../ipc/session-contract";

import { Resource } from "./Resource";

/** A session's discovery and activation of a shared resource. */
export class CompatibilityResource extends Model {
  @id id = "";
  @modelRef(Resource) resource: Resource | undefined;
  get kind(): CompatibilityResourceRecord["kind"] {
    return this.resource?.kind ?? "extension";
  }
  name = "";
  description: string | undefined;
  get path() {
    return this.resource?.path;
  }
  source = "";
  scope: CompatibilityResourceRecord["scope"] = "user";
  origin: CompatibilityResourceRecord["origin"] = "top-level";
  commands: string[] = observable([]);
  tools: string[] = observable([]);
  enabled = true;

  get value(): CompatibilityResourceRecord {
    return {
      id: this.resource?.id ?? "",
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
