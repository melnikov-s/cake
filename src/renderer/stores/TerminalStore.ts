import { Store } from "r-state-tree";
import { RendererClientContext } from "../client/RendererClientContext";

export type TerminalTarget =
  | { kind: "project"; sessionId: string; workspacePath: string }
  | { kind: "cake-chat"; sessionId: string };

export interface TerminalEntry {
  key: string;
  target: TerminalTarget;
  terminalId?: string;
  shell?: string;
  opening: boolean;
  error?: string;
}

interface PendingResolution {
  keys: string[];
  finish(proceed: boolean): void;
}

/** Owns the window's lazy, in-memory terminal collection, keyed by Cake session. */
export class TerminalStore extends Store<{
  activeTarget(): TerminalTarget | undefined;
}> {
  get terminals() {
    return RendererClientContext.consume(this)!.terminals;
  }

  open = false;
  entries: TerminalEntry[] = [];
  resolutionRequest: { runningProgramCount: number } | undefined;
  private pendingResolution: PendingResolution | undefined;
  private readonly dataListeners = new Map<string, Set<(data: string) => void>>();
  private readonly bufferedData = new Map<string, string>();
  private readonly orphanEvents = new Map<
    string,
    Array<
      | { type: "terminal-data"; terminalId: string; data: string }
      | { type: "terminal-exited"; terminalId: string; exitCode: number }
    >
  >();

  constructor(props: TerminalStore["props"]) {
    super(props);
    this.reaction(
      () => ({
        open: this.open,
        key: this.activeTarget ? this.targetKey(this.activeTarget) : undefined,
      }),
      ({ open, key }) => {
        if (!key) {
          this.open = false;
          return;
        }
        if (open) void this.ensureCurrent();
      },
    );
    this.effect(() => {
      const terminals = this.terminals;
      return () => {
        this.pendingResolution?.finish(false);
        for (const entry of this.entries) {
          if (entry.terminalId) void terminals.close(entry.terminalId).catch(() => undefined);
        }
      };
    });
  }

  get activeTarget() {
    return this.props.activeTarget();
  }

  get available() {
    return Boolean(this.activeTarget && this.terminals.open);
  }

  get activeEntry() {
    const target = this.activeTarget;
    return target ? this.entries.find((entry) => entry.key === this.targetKey(target)) : undefined;
  }

  async toggle() {
    if (this.open) {
      this.hide();
      return;
    }
    if (!this.available) return;
    this.open = true;
    await this.ensureCurrent();
  }

  hide() {
    this.open = false;
  }

  async restart(key: string, cols: number, rows: number) {
    const entry = this.entries.find((candidate) => candidate.key === key);
    if (entry) await this.start(entry.target, cols, rows);
  }

  private async ensureCurrent(cols = 80, rows = 24) {
    const target = this.activeTarget;
    if (!target) return;
    const entry = this.entries.find((candidate) => candidate.key === this.targetKey(target));
    if (!entry || (!entry.terminalId && !entry.opening)) await this.start(target, cols, rows);
  }

  private async start(target: TerminalTarget, cols: number, rows: number) {
    const openTerminal = this.terminals.open;
    if (!openTerminal) return;
    const key = this.targetKey(target);
    const current = this.entries.find((entry) => entry.key === key);
    if (current?.opening || current?.terminalId) return;
    this.setEntry({ key, target, opening: true });
    try {
      const opened = await openTerminal({ target, cols, rows });
      if (this.signal.aborted) {
        await this.terminals.close(opened.terminalId);
        return;
      }
      this.setEntry({ key, target, opening: false, ...opened });
      const orphaned = this.orphanEvents.get(opened.terminalId);
      this.orphanEvents.delete(opened.terminalId);
      for (const event of orphaned ?? []) this.receive(event);
    } catch (error) {
      this.setEntry({
        key,
        target,
        opening: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  write(key: string, data: string) {
    const terminalId = this.entries.find((entry) => entry.key === key)?.terminalId;
    if (!terminalId || !data) return;
    void this.terminals.write(terminalId, data).catch((error) => {
      this.updateEntry(key, { error: error instanceof Error ? error.message : String(error) });
    });
  }

  resize(key: string, cols: number, rows: number) {
    const terminalId = this.entries.find((entry) => entry.key === key)?.terminalId;
    if (!terminalId) return;
    void this.terminals.resize(terminalId, cols, rows).catch(() => undefined);
  }

  receive(
    event:
      | { type: "terminal-data"; terminalId: string; data: string }
      | { type: "terminal-exited"; terminalId: string; exitCode: number },
  ) {
    const entry = this.entries.find((candidate) => candidate.terminalId === event.terminalId);
    if (!entry) {
      if (this.entries.some((candidate) => candidate.opening)) {
        const events = this.orphanEvents.get(event.terminalId) ?? [];
        events.push(event);
        this.orphanEvents.set(event.terminalId, events);
      }
      return;
    }
    if (event.type === "terminal-data") {
      const listeners = this.dataListeners.get(entry.key);
      if (listeners?.size) for (const listener of listeners) listener(event.data);
      else
        this.bufferedData.set(
          entry.key,
          `${this.bufferedData.get(entry.key) ?? ""}${event.data}`.slice(-1_000_000),
        );
      return;
    }
    this.updateEntry(entry.key, {
      terminalId: undefined,
      shell: undefined,
      error: event.exitCode === 0 ? "Shell exited" : `Shell exited with code ${event.exitCode}`,
    });
  }

  subscribeData(key: string, listener: (data: string) => void) {
    const listeners = this.dataListeners.get(key) ?? new Set();
    listeners.add(listener);
    this.dataListeners.set(key, listeners);
    const buffered = this.bufferedData.get(key);
    if (buffered) {
      listener(buffered);
      this.bufferedData.delete(key);
    }
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.dataListeners.delete(key);
    };
  }

  async prepareResolution(targets: readonly Pick<TerminalTarget, "kind" | "sessionId">[]) {
    const targetKeys = new Set(targets.map((target) => `${target.kind}:${target.sessionId}`));
    const terminals = this.entries.flatMap((entry) =>
      entry.terminalId && targetKeys.has(entry.key)
        ? [{ key: entry.key, terminalId: entry.terminalId }]
        : [],
    );
    if (terminals.length === 0) return true;
    if (this.pendingResolution) return false;

    const statuses = await Promise.allSettled(
      terminals.map(({ terminalId }) => this.terminals.status(terminalId)),
    );
    const keys = terminals.flatMap((terminal, index) => {
      const status = statuses[index];
      return status?.status === "fulfilled" && status.value.runningProgram ? [terminal.key] : [];
    });
    if (keys.length === 0) return true;
    if (this.pendingResolution) return false;

    return new Promise<boolean>((finish) => {
      this.pendingResolution = { keys, finish };
      this.resolutionRequest = { runningProgramCount: keys.length };
    });
  }

  discardResolvedSessions(targets: readonly Pick<TerminalTarget, "kind" | "sessionId">[]) {
    const targetKeys = new Set(targets.map((target) => `${target.kind}:${target.sessionId}`));
    const keys = this.entries
      .filter((entry) => targetKeys.has(entry.key))
      .map((entry) => entry.key);
    if (keys.length > 0) void this.closeKeys(keys);
  }

  cancelResolution() {
    this.finishResolution(false);
  }

  async confirmResolution() {
    const pending = this.pendingResolution;
    if (!pending) return;
    this.pendingResolution = undefined;
    this.resolutionRequest = undefined;
    await this.closeKeys(pending.keys);
    pending.finish(true);
  }

  private finishResolution(proceed: boolean) {
    const pending = this.pendingResolution;
    if (!pending) return;
    this.pendingResolution = undefined;
    this.resolutionRequest = undefined;
    pending.finish(proceed);
  }

  private async closeKeys(keys: readonly string[]) {
    const closing = this.entries.filter((entry) => keys.includes(entry.key));
    await Promise.allSettled(
      closing.map((entry) =>
        entry.terminalId ? this.terminals.close(entry.terminalId) : Promise.resolve(),
      ),
    );
    const keySet = new Set(keys);
    this.entries = this.entries.filter((entry) => !keySet.has(entry.key));
    for (const key of keys) {
      this.dataListeners.delete(key);
      this.bufferedData.delete(key);
    }
  }

  private targetKey(target: Pick<TerminalTarget, "kind" | "sessionId">) {
    return `${target.kind}:${target.sessionId}`;
  }

  private setEntry(entry: TerminalEntry) {
    const index = this.entries.findIndex((candidate) => candidate.key === entry.key);
    this.entries =
      index < 0
        ? [...this.entries, entry]
        : this.entries.map((candidate, candidateIndex) =>
            candidateIndex === index ? entry : candidate,
          );
  }

  private updateEntry(key: string, update: Partial<TerminalEntry>) {
    const entry = this.entries.find((candidate) => candidate.key === key);
    if (entry) this.setEntry({ ...entry, ...update });
  }
}
