import { Store } from "r-state-tree";
import type {
  Automation,
  AutomationContext,
  AutomationDefinition,
  AutomationEventSessionKind,
  AutomationId,
} from "../../contracts/automations/automation-data";
import { ClientContext } from "./context/ClientContext";

const projectSessionKinds: readonly AutomationEventSessionKind[] = [
  "project-chat",
  "standalone-project-session",
  "family-root",
  "family-child",
];
const globalSessionKinds: readonly AutomationEventSessionKind[] = ["cake-chat"];

function sessionKindsForProject(project: AutomationContext) {
  return project._tag === "Project" ? projectSessionKinds : globalSessionKinds;
}

/** The selected project owns both the execution directory and the event source. */
function bindEventToProject(definition: AutomationDefinition): AutomationDefinition {
  if (definition.trigger._tag !== "Event") return definition;
  const filter = definition.trigger.filter;
  const available = sessionKindsForProject(definition.context);
  const selected = filter.sessionKinds.filter((kind) => available.includes(kind));
  return {
    ...definition,
    trigger: {
      _tag: "Event",
      filter: {
        ...filter,
        scope: definition.context,
        sessionKinds: selected.length ? selected : available,
      },
    },
  };
}

/** Owns the unsaved automation definition and its creation workflow. */
export class AutomationEditorStore extends Store {
  automation: Automation | undefined;
  definition: AutomationDefinition | undefined;
  creating = false;
  loading = false;
  saving = false;
  choosingAttachments = false;
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
    this.definition = bindEventToProject(definition);
    this.creating = true;
    this.initialState = "active";
    this.error = undefined;
  }

  close() {
    this.request?.abort();
    this.loading = false;
    this.automation = undefined;
    this.definition = undefined;
    this.creating = false;
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
      this.definition = bindEventToProject(result.automation.definition);
    } catch (error) {
      if (!this.signal.aborted && !request.signal.aborted)
        this.error = error instanceof Error ? error.message : String(error);
    } finally {
      if (!this.signal.aborted && !request.signal.aborted) this.loading = false;
    }
  }

  get eventSessionKinds() {
    return sessionKindsForProject(this.definition?.context ?? { _tag: "Global" });
  }

  setProject(project: AutomationContext) {
    const trigger = this.definition?.trigger;
    if (trigger?._tag === "Event") {
      const filter = { ...trigger.filter };
      delete filter.sessionId;
      this.patch({ context: project, trigger: { _tag: "Event", filter } });
    } else this.patch({ context: project });
  }
  patch(patch: Partial<AutomationDefinition>) {
    if (this.definition && !this.saving)
      this.definition = bindEventToProject({ ...this.definition, ...patch });
  }
  async addAttachments() {
    if (this.choosingAttachments || !this.definition) return;
    this.choosingAttachments = true;
    this.error = undefined;
    try {
      const attachments = await this.client.filesystem.chooseAttachments({ signal: this.signal });
      if (!this.signal.aborted && this.definition)
        this.patch({
          task: {
            ...this.definition.task,
            attachments: [...this.definition.task.attachments, ...attachments],
          },
        });
    } catch (error) {
      if (!this.signal.aborted) this.error = error instanceof Error ? error.message : String(error);
    } finally {
      if (!this.signal.aborted) this.choosingAttachments = false;
    }
  }
  removeAttachment(index: number) {
    if (this.definition)
      this.patch({
        task: {
          ...this.definition.task,
          attachments: this.definition.task.attachments.filter(
            (_, candidate) => candidate !== index,
          ),
        },
      });
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
