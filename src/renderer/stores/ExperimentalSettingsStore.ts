import { Store } from "r-state-tree";
import type { ExperimentalFeatures } from "../models/ExperimentalFeatures";
import { ClientContext } from "./context/ClientContext";
import { describeError } from "../lib/error-details";

/** Main owns availability; the Model observer projects it. This Store owns one pending edit.
 * Saves are serialized; only authoritative observations change the displayed flag.
 */
export class ExperimentalSettingsStore extends Store<{ model: ExperimentalFeatures }> {
  get dynamicWorkflows() {
    return this.props.model.dynamicWorkflows;
  }
  saving = false;
  error: string | undefined;
  errorDetails: string | undefined;
  async setDynamicWorkflows(enabled: boolean) {
    if (this.saving || this.signal.aborted) return;
    this.saving = true;
    this.error = undefined;
    this.errorDetails = undefined;
    try {
      await ClientContext.consume(this)!.application.setExperimentalFeatures(
        { features: { dynamicWorkflows: enabled } },
        { signal: this.signal },
      );
    } catch (error) {
      if (this.signal.aborted) return;
      const described = describeError(error);
      this.error = described.message;
      this.errorDetails = described.details;
    } finally {
      if (!this.signal.aborted) this.saving = false;
    }
  }
}
