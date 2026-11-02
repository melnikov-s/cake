import { Store } from "r-state-tree";
import type {
  Automation,
  AutomationContext,
  AutomationDefinition,
  AutomationId,
} from "../../contracts/automations/automation-data";
import { ClientContext } from "./context/ClientContext";

/** Owns unsaved definition edits and the Context → Trigger → Task creation workflow. */
export class AutomationEditorStore extends Store {
  automation: Automation | undefined;
  definition: AutomationDefinition | undefined;
  step: "context" | "trigger" | "task" = "context";
  creating = false;
  loading = false;
  saving = false;
  initialState: "active" | "paused" = "active";
  error: string | undefined;
  private request: AbortController | undefined;

  private get client() {
    return ClientContext.consume(this)!;
  }

  constructor(props: AutomationEditorStore["props"]) {
    super(props);
    this.effect(() => () => this.request?.abort());
  }

  beginCreate(definition: AutomationDefinition) {
    this.request?.abort();
    this.loading = false;
    this.automation = undefined;
    this.definition = definition;
    this.creating = true;
    this.step = "context";
    this.initialState = "active";
    this.error = undefined;
  }

  async open(automationId: AutomationId) {
    this.request?.abort();
    const request = new AbortController();
    this.request = request;
    this.loading = true;
    this.creating = false;
    this.automation = undefined;
    this.definition = undefined;
    this.error = undefined;
    try {
      const result = await this.client.automations.inspect(
        { automationId },
        { signal: AbortSignal.any([this.signal, request.signal]) },
      );
      if (this.signal.aborted || request.signal.aborted) return;
      this.automation = result.automation;
      this.definition = result.automation.definition;
    } catch (error) {
      if (!this.signal.aborted && !request.signal.aborted)
        this.error = error instanceof Error ? error.message : String(error);
    } finally {
      if (!this.signal.aborted && !request.signal.aborted) this.loading = false;
    }
  }

  setContext(context: AutomationContext) {
    this.patch({ context });
  }
  patch(patch: Partial<AutomationDefinition>) {
    if (this.definition && !this.saving) this.definition = { ...this.definition, ...patch };
  }
  setStep(step: AutomationEditorStore["step"]) {
    this.step = step;
  }

  /** Ignore repeated saves. The backend validates the complete explicit definition. */
  async save() {
    if (!this.definition || this.saving || this.loading) return undefined;
    const definition = this.definition;
    const automationId = this.automation?.id;
    this.saving = true;
    this.error = undefined;
    try {
      const result = automationId
        ? await this.client.automations.update(
            { automationId, definition },
            { signal: this.signal },
          )
        : await this.client.automations.create(
            { definition, initialState: this.initialState },
            { signal: this.signal },
          );
      if (this.signal.aborted) return undefined;
      // Selection may have changed while saving; do not replace the newly opened draft.
      if (this.definition === definition) {
        this.automation = result;
        this.definition = result.definition;
        this.creating = false;
      }
      return result;
    } catch (error) {
      if (!this.signal.aborted) this.error = error instanceof Error ? error.message : String(error);
      return undefined;
    } finally {
      if (!this.signal.aborted) this.saving = false;
    }
  }
}
