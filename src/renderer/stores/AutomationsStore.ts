import { Store, child, createStore } from "r-state-tree";
import type {
  Automation,
  AutomationContext,
  AutomationDefinition,
  AutomationId,
  AutomationRun,
} from "../../contracts/automations/automation-data";
import type { AutomationTriggerResult } from "../../contracts/automations/automation-control";
import type { AutomationCatalog } from "../models/AutomationCatalog";
import { AutomationEditorStore } from "./AutomationEditorStore";
import { AutomationHistoryStore } from "./AutomationHistoryStore";
import { AutomationMemoryStore } from "./AutomationMemoryStore";
import { ClientContext } from "./context/ClientContext";

/** Management/status hub workflow, distinct from independently living run conversations. */
export class AutomationsStore extends Store<{
  catalog: AutomationCatalog;
  openRun?(run: AutomationRun): void;
}> {
  project: AutomationContext | undefined;
  state: "active" | "paused" | "suspended" | "archived" | undefined;
  runningOnly = false;
  globalHistory = false;
  selectedId: AutomationId | undefined;
  tab: "definition" | "runs" | "memory" = "definition";
  changing = false;
  error: string | undefined;
  lastTrigger: AutomationTriggerResult | undefined;
  archiveConfirmationId: AutomationId | undefined;
  private get client() {
    return ClientContext.consume(this)!;
  }
  get catalog() {
    return this.props.catalog;
  }

  @child get editor(): AutomationEditorStore {
    return createStore(AutomationEditorStore);
  }
  @child get history(): AutomationHistoryStore {
    return createStore(AutomationHistoryStore);
  }
  @child get memory(): AutomationMemoryStore {
    return createStore(AutomationMemoryStore);
  }

  get filtered() {
    const context = this.project;
    return this.catalog.automations.filter(
      (item) =>
        (!this.runningOnly || item.activity.runningSessions > 0) &&
        (!this.state || item.state._tag === this.state) &&
        (!context ||
          (context._tag === "Global"
            ? item.context._tag === "Global"
            : item.context._tag === "Project" && item.context.projectPath === context.projectPath)),
    );
  }
  get runningAutomationCount() {
    return this.catalog.automations.filter((item) => item.activity.runningSessions > 0).length;
  }
  get activeSessionCount() {
    return this.catalog.automations.reduce(
      (count, item) => count + item.activity.runningSessions,
      0,
    );
  }
  get queuedOccurrenceCount() {
    return this.catalog.automations.reduce(
      (count, item) => count + item.activity.queuedOccurrences,
      0,
    );
  }
  setProject(project: AutomationContext | undefined) {
    this.project = project;
  }
  setState(state: AutomationsStore["state"]) {
    this.state = state;
    this.runningOnly = false;
  }
  showRunning() {
    this.state = undefined;
    this.runningOnly = true;
  }
  async showGlobalHistory() {
    this.showOverview();
    this.globalHistory = true;
    this.history.select(undefined);
    await this.history.load();
  }
  showOverview() {
    this.globalHistory = false;
    this.selectedId = undefined;
    this.editor.close();
    this.archiveConfirmationId = undefined;
  }

  async select(automationId: AutomationId) {
    this.globalHistory = false;
    this.selectedId = automationId;
    this.tab = "definition";
    this.lastTrigger = undefined;
    this.archiveConfirmationId = undefined;
    this.history.select(automationId);
    this.memory.select(automationId);
    await this.editor.open(automationId);
  }

  beginCreate(definition: AutomationDefinition) {
    this.globalHistory = false;
    this.selectedId = undefined;
    this.tab = "definition";
    this.archiveConfirmationId = undefined;
    this.lastTrigger = undefined;
    this.history.select(undefined);
    this.memory.select(undefined);
    this.editor.beginCreate(definition);
  }

  async save() {
    const automation = await this.editor.save();
    if (!automation || this.editor.automation?.id !== automation.id) return;
    this.selectedId = automation.id;
    this.history.select(automation.id);
    this.memory.select(automation.id);
  }

  async showTab(tab: AutomationsStore["tab"]) {
    this.tab = tab;
    if (tab === "runs" && !this.history.loaded) await this.history.load();
    if (tab === "memory" && !this.memory.view) await this.memory.load();
  }

  async pause(automationId: AutomationId) {
    return this.change(() =>
      this.client.automations.pause({ automationId }, { signal: this.signal }),
    );
  }
  async activate(automationId: AutomationId) {
    return this.change(() =>
      this.client.automations.activate({ automationId }, { signal: this.signal }),
    );
  }
  async runNow(automationId: AutomationId) {
    return this.change(async () => {
      const result = await this.client.automations.trigger(
        { automationId },
        { signal: this.signal },
      );
      if (this.signal.aborted) return;
      this.lastTrigger = result;
      if (result._tag === "started" && this.props.openRun) {
        const page = await this.client.automations.history(
          { automationId, limit: 20 },
          { signal: this.signal },
        );
        const run = page.runs.find((run) => run.id === result.runId);
        if (!this.signal.aborted && run) this.props.openRun(run);
      }
      if (this.history.automationId === automationId && this.history.loaded)
        await this.history.load();
    });
  }

  /** A running definition requires an explicit let-finish/stop decision. No implicit stopping. */
  async requestArchive(automationId: AutomationId) {
    if (
      this.catalog.automations.find((item) => item.id === automationId)?.activity.runningSessions
    ) {
      this.archiveConfirmationId = automationId;
      return false;
    }
    return this.archive(automationId, "let-finish");
  }
  dismissArchiveConfirmation() {
    this.archiveConfirmationId = undefined;
  }
  async archive(automationId: AutomationId, runningSessions: "let-finish" | "stop") {
    return this.change(async () => {
      await this.client.automations.archive(
        { automationId, runningSessions },
        { signal: this.signal },
      );
      if (!this.signal.aborted) this.archiveConfirmationId = undefined;
    });
  }

  private async change(command: () => Promise<Automation | void>) {
    if (this.changing) return false;
    this.changing = true;
    this.error = undefined;
    try {
      await command();
      return !this.signal.aborted;
    } catch (error) {
      if (!this.signal.aborted) this.error = error instanceof Error ? error.message : String(error);
      return false;
    } finally {
      if (!this.signal.aborted) this.changing = false;
    }
  }
}
