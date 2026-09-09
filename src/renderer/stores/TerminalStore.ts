import { Store } from "r-state-tree";
import { ClientContext } from "./context/ClientContext";
import type { WorkingDirectoryRetirementStore } from "./WorkingDirectoryRetirementStore";

export interface TerminalTarget {
  workingDirectory: string;
  label: string;
}

export interface TerminalEntry {
  key: string;
  target: TerminalTarget;
  terminalId?: string;
  shell?: string;
  opening: boolean;
  error?: string;
}

/** Owns the window's lazy, in-memory terminal collections, keyed by Working Directory. */
export class TerminalStore extends Store<{
  activeTarget(): TerminalTarget | undefined;
  retirement(): WorkingDirectoryRetirementStore;
  toggleAcceleratorHint(): string;
  newTabHotkey(): string;
}> {
  get terminals() {
    return ClientContext.consume(this)!.terminals;
  }

  open = false;
  docked = false;
  entries: TerminalEntry[] = [];
  activeEntryKeys: Record<string, string> = {};
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
        for (const entry of this.entries) {
          if (entry.terminalId) void terminals.close(entry.terminalId).catch(() => undefined);
        }
      };
    });
  }

  get activeTarget() {
    return this.props.activeTarget();
  }

  get toggleAcceleratorHint() {
    return this.props.toggleAcceleratorHint();
  }

  get newTabHotkey() {
    return this.props.newTabHotkey();
  }

  get available() {
    return Boolean(this.activeTarget && this.terminals.open);
  }

  get activeEntries() {
    const target = this.activeTarget;
    if (!target) return [];
    const targetKey = this.targetKey(target);
    return this.entries.filter((entry) => this.targetKey(entry.target) === targetKey);
  }

  get activeEntry() {
    const target = this.activeTarget;
    if (!target) return undefined;
    const activeKey = this.activeEntryKeys[this.targetKey(target)];
    return this.activeEntries.find((entry) => entry.key === activeKey) ?? this.activeEntries.at(-1);
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

  dock() {
    this.docked = true;
  }

  moveToTop() {
    this.docked = false;
  }

  activate(key: string) {
    const entry = this.entries.find((candidate) => candidate.key === key);
    if (!entry || this.targetKey(entry.target) !== this.activeTargetKey) return;
    this.setActiveEntry(entry.target, key);
  }

  async newTab(cols = 80, rows = 24) {
    const target = this.activeTarget;
    if (!target) return;
    this.open = true;
    await this.start(target, cols, rows, true);
  }

  async closeTab(key: string) {
    const entry = this.entries.find((candidate) => candidate.key === key);
    if (!entry) return;
    if (entry.terminalId) await this.terminals.close(entry.terminalId).catch(() => undefined);
    const targetKey = this.targetKey(entry.target);
    const remaining = this.entries.filter(
      (candidate) => candidate.key !== key && this.targetKey(candidate.target) === targetKey,
    );
    this.entries = this.entries.filter((candidate) => candidate.key !== key);
    this.dataListeners.delete(key);
    this.bufferedData.delete(key);
    const next = remaining.at(-1);
    if (next) this.setActiveEntry(next.target, next.key);
    else {
      const activeEntryKeys = { ...this.activeEntryKeys };
      delete activeEntryKeys[targetKey];
      this.activeEntryKeys = activeEntryKeys;
      if (targetKey === this.activeTargetKey) this.open = false;
    }
  }

  async restart(key: string, cols: number, rows: number) {
    const entry = this.entries.find((candidate) => candidate.key === key);
    if (entry) await this.start(entry.target, cols, rows);
  }

  private get activeTargetKey() {
    return this.activeTarget ? this.targetKey(this.activeTarget) : undefined;
  }

  private async ensureCurrent(cols = 80, rows = 24) {
    const target = this.activeTarget;
    if (!target) return;
    const entry = this.activeEntry;
    if (!entry || (!entry.terminalId && !entry.opening)) await this.start(target, cols, rows);
  }

  private async start(target: TerminalTarget, cols: number, rows: number, forceNew = false) {
    if (this.props.retirement().isRetiring(target.workingDirectory) || this.signal.aborted) return;
    const openTerminal = this.terminals.open;
    if (!openTerminal) return;
    const current = this.activeEntry;
    if (!forceNew && current && this.targetKey(current.target) === this.targetKey(target)) {
      if (current.opening || current.terminalId) return;
      return this.restartEntry(current, cols, rows);
    }
    const key = `${this.targetKey(target)}:${crypto.randomUUID()}`;
    this.setEntry({ key, target, opening: true });
    this.setActiveEntry(target, key);
    await this.openEntry(key, target, cols, rows);
  }

  private async restartEntry(entry: TerminalEntry, cols: number, rows: number) {
    this.setEntry({
      ...entry,
      terminalId: undefined,
      shell: undefined,
      opening: true,
      error: undefined,
    });
    await this.openEntry(entry.key, entry.target, cols, rows);
  }

  private async openEntry(key: string, target: TerminalTarget, cols: number, rows: number) {
    const openTerminal = this.terminals.open;
    if (!openTerminal) return;
    try {
      const opened = await openTerminal({
        target: { workingDirectory: target.workingDirectory },
        cols,
        rows,
      });
      if (this.signal.aborted || !this.entries.some((entry) => entry.key === key)) {
        this.orphanEvents.delete(opened.terminalId);
        await this.terminals.close(opened.terminalId).catch(() => undefined);
        return;
      }
      this.setEntry({ key, target, opening: false, ...opened });
      const orphaned = this.orphanEvents.get(opened.terminalId);
      this.orphanEvents.delete(opened.terminalId);
      for (const event of orphaned ?? []) this.receive(event);
    } catch (error) {
      if (this.signal.aborted || !this.entries.some((entry) => entry.key === key)) return;
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
      this.bufferedData.set(
        entry.key,
        `${this.bufferedData.get(entry.key) ?? ""}${event.data}`.slice(-1_000_000),
      );
      const listeners = this.dataListeners.get(entry.key);
      if (listeners?.size) for (const listener of listeners) listener(event.data);
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
    if (buffered) listener(buffered);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.dataListeners.delete(key);
    };
  }

  releaseWorkingDirectories(workingDirectories: readonly string[]) {
    const keySet = new Set(
      this.entries
        .filter((entry) => workingDirectories.includes(entry.target.workingDirectory))
        .map((entry) => entry.key),
    );
    const removedTargetKeys = new Set(
      this.entries
        .filter((entry) => keySet.has(entry.key))
        .map((entry) => this.targetKey(entry.target)),
    );
    this.entries = this.entries.filter((entry) => !keySet.has(entry.key));
    this.activeEntryKeys = Object.fromEntries(
      Object.entries(this.activeEntryKeys).filter(
        ([targetKey, entryKey]) => !removedTargetKeys.has(targetKey) || !keySet.has(entryKey),
      ),
    );
    for (const key of keySet) {
      this.dataListeners.delete(key);
      this.bufferedData.delete(key);
    }
  }

  private targetKey(target: Pick<TerminalTarget, "workingDirectory">) {
    return target.workingDirectory;
  }

  private setActiveEntry(target: TerminalTarget, key: string) {
    this.activeEntryKeys = { ...this.activeEntryKeys, [this.targetKey(target)]: key };
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
