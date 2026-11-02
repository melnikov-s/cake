import { Store, observable } from "r-state-tree";
import type { AutomationId } from "../../contracts/automations/automation-data";
import type {
  OptMemoryRange,
  OptMemoryView,
  OptMemoryZoom,
} from "../../contracts/memory/opt-memory-data";
import { ClientContext } from "./context/ClientContext";

/** Read-only shared automation memory. Zoom recursively reaches exact paged originals. */
export class AutomationMemoryStore extends Store {
  automationId: AutomationId | undefined;
  view: OptMemoryView | undefined;
  readonly path: { range: OptMemoryRange; zoom: OptMemoryZoom }[] = observable([]);
  loading = false;
  error: string | undefined;
  private request: AbortController | undefined;
  private get client() {
    return ClientContext.consume(this)!;
  }
  get current() {
    return this.path.at(-1);
  }
  get lines() {
    return this.current?.zoom._tag === "Branch"
      ? this.current.zoom.children
      : this.path.length
        ? []
        : (this.view?.lines ?? []);
  }

  constructor(props: AutomationMemoryStore["props"]) {
    super(props);
    this.effect(() => () => this.request?.abort());
  }

  select(automationId: AutomationId | undefined) {
    this.request?.abort();
    this.automationId = automationId;
    this.view = undefined;
    this.path.splice(0);
    this.loading = false;
    this.error = undefined;
  }

  async load() {
    const automationId = this.automationId;
    if (!automationId) return;
    await this.read(
      (signal) => this.client.automations.readMemory({ automationId }, { signal }),
      (view) => {
        this.view = view;
        this.path.splice(0);
      },
    );
  }

  async zoom(range: OptMemoryRange) {
    const automationId = this.automationId;
    if (!automationId) return;
    await this.read(
      (signal) =>
        this.client.automations.zoomMemory({ automationId, range, maxChars: 8000 }, { signal }),
      (zoom) => {
        this.path.push({ range, zoom });
      },
    );
  }

  async loadMoreOriginal() {
    const automationId = this.automationId;
    const frame = this.current;
    if (
      !automationId ||
      !frame ||
      frame.zoom._tag !== "Original" ||
      frame.zoom.nextOffset === null ||
      this.loading
    )
      return;
    const original = frame.zoom;
    await this.read(
      (signal) =>
        this.client.automations.zoomMemory(
          { automationId, range: frame.range, offset: original.nextOffset ?? 0, maxChars: 8000 },
          { signal },
        ),
      (zoom) => {
        if (zoom._tag !== "Original") return;
        this.path.splice(this.path.length - 1, 1, {
          range: frame.range,
          zoom: { ...zoom, offset: original.offset, text: original.text + zoom.text },
        });
      },
    );
  }

  back() {
    this.request?.abort();
    this.loading = false;
    this.error = undefined;
    this.path.pop();
  }

  private async read<Value>(
    command: (signal: AbortSignal) => Promise<Value>,
    commit: (value: Value) => void,
  ) {
    this.request?.abort();
    const request = new AbortController();
    this.request = request;
    this.loading = true;
    this.error = undefined;
    try {
      const value = await command(AbortSignal.any([this.signal, request.signal]));
      if (!this.signal.aborted && !request.signal.aborted) commit(value);
    } catch (error) {
      if (!this.signal.aborted && !request.signal.aborted)
        this.error = error instanceof Error ? error.message : String(error);
    } finally {
      if (!this.signal.aborted && !request.signal.aborted) this.loading = false;
    }
  }
}
