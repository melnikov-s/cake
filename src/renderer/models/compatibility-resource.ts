import { Model, id, observable, state } from "r-state-tree";
import type { CompatibilityResource, ResourceDiagnostic } from "../../ipc/session-contract";

export class CompatibilityResourceModel extends Model {
  @id id = "";
  @state kind: CompatibilityResource["kind"] = "extension";
  @state name = "";
  @state description: string | undefined;
  @state path: string | undefined;
  @state source = "";
  @state scope: CompatibilityResource["scope"] = "user";
  @state origin: CompatibilityResource["origin"] = "top-level";
  @state commands: string[] = observable([]);
  @state tools: string[] = observable([]);
  @state enabled = true;

  get value(): CompatibilityResource {
    return { id: this.id, kind: this.kind, name: this.name, description: this.description, path: this.path, source: this.source, scope: this.scope, origin: this.origin, commands: this.commands.slice(), tools: this.tools.slice(), enabled: this.enabled };
  }
}

export class ResourceDiagnosticModel extends Model {
  @id id = "";
  @state severity: ResourceDiagnostic["severity"] = "info";
  @state source: ResourceDiagnostic["source"] = "runtime";
  @state message = "";
  @state path: string | undefined;
  @state method: string | undefined;

  get value(): ResourceDiagnostic {
    return { id: this.id, severity: this.severity, source: this.source, message: this.message, path: this.path, method: this.method };
  }
}
