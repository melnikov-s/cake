import { Store, observable } from "r-state-tree";
import type {
  AutomationId,
  AutomationOccurrence,
  AutomationOccurrenceId,
  AutomationRun,
  AutomationRunId,
} from "../../contracts/automations/automation-data";
import { ClientContext } from "./context/ClientContext";

/** Occurrence provenance and real run links, independently paged from definition and memory. */
export class AutomationHistoryStore extends Store {
  automationId: AutomationId | undefined;
  readonly occurrences: AutomationOccurrence[] = observable([]);
  readonly runs: AutomationRun[] = observable([]);
  total = 0;
  nextOffset: number | null = null;
  loaded = false;
  loading = false;
  changing = false;
  error: string | undefined;
  private request: AbortController | undefined;
  private get client() {
    return ClientContext.consume(this)!;
  }

  constructor(props: AutomationHistoryStore["props"]) {
    super(props);
    this.effect(() => () => this.request?.abort());
  }

  select(automationId: AutomationId | undefined) {
    this.request?.abort();
    this.automationId = automationId;
    this.occurrences.splice(0);
    this.runs.splice(0);
    this.total = 0;
    this.nextOffset = null;
    this.loaded = false;
    this.loading = false;
    this.error = undefined;
  }

  async load(more = false) {
    const automationId = this.automationId;
    if (more && (this.loading || this.nextOffset === null)) return;
    this.request?.abort();
    const request = new AbortController();
    this.request = request;
    this.loading = true;
    this.error = undefined;
    try {
      const page = await this.client.automations.history(
        {
          ...(automationId ? { automationId } : null),
          offset: more ? (this.nextOffset ?? 0) : 0,
          limit: 20,
        },
        { signal: AbortSignal.any([this.signal, request.signal]) },
      );
      if (this.signal.aborted || request.signal.aborted) return;
      if (!more) {
        this.occurrences.splice(0);
        this.runs.splice(0);
      }
      for (const occurrence of page.occurrences) {
        const index = this.occurrences.findIndex((item) => item.id === occurrence.id);
        if (index >= 0) this.occurrences[index] = occurrence;
        else this.occurrences.push(occurrence);
      }
      for (const run of page.runs) {
        const index = this.runs.findIndex((item) => item.id === run.id);
        if (index >= 0) this.runs[index] = run;
        else this.runs.push(run);
      }
      this.total = page.total;
      this.nextOffset = page.nextOffset;
      this.loaded = true;
    } catch (error) {
      if (!this.signal.aborted && !request.signal.aborted)
        this.error = error instanceof Error ? error.message : String(error);
    } finally {
      if (!this.signal.aborted && !request.signal.aborted) this.loading = false;
    }
  }

  async cancelRun(runId: AutomationRunId) {
    return this.change(() => this.client.automations.cancelRun({ runId }, { signal: this.signal }));
  }
  async cancelQueued(occurrenceId: AutomationOccurrenceId) {
    return this.change(() =>
      this.client.automations.cancelQueued({ occurrenceId }, { signal: this.signal }),
    );
  }
  private async change(command: () => Promise<void>) {
    if (this.changing) return false;
    this.changing = true;
    this.error = undefined;
    try {
      await command();
      if (this.signal.aborted) return false;
      await this.load();
      return true;
    } catch (error) {
      if (!this.signal.aborted) this.error = error instanceof Error ? error.message : String(error);
      return false;
    } finally {
      if (!this.signal.aborted) this.changing = false;
    }
  }
}
