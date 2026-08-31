import { Model, id } from "r-state-tree";
import type { ResourceDiagnostic as ResourceDiagnosticRecord } from "../../ipc/session-contract";

export class ResourceDiagnostic extends Model {
  @id id = "";
  severity: ResourceDiagnosticRecord["severity"] = "info";
  source: ResourceDiagnosticRecord["source"] = "runtime";
  message = "";
  path: string | undefined;
  method: string | undefined;

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
