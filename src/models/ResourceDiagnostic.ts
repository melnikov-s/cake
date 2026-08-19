import { Model, id, state } from "r-state-tree";
import type { ResourceDiagnostic as ResourceDiagnosticRecord } from "../ipc/session-contract";

export class ResourceDiagnostic extends Model {
  @id id = "";
  @state severity: ResourceDiagnosticRecord["severity"] = "info";
  @state source: ResourceDiagnosticRecord["source"] = "runtime";
  @state message = "";
  @state path: string | undefined;
  @state method: string | undefined;

  get value(): ResourceDiagnosticRecord {
    return {
      id: this.id,
      severity: this.severity,
      source: this.source,
      message: this.message,
      path: this.path,
      method: this.method,
    };
  }
}
