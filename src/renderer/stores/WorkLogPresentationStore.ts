import { observable, Store, untracked } from "r-state-tree";
import type { UiPart, WorkLogsExpansion, WorkLogViewMode } from "../../ipc/session-contract";
import { workLogGroupKeys } from "../../utils/work-log-groups";

export interface WorkLogPresentationCapabilities {
  viewMode?(): WorkLogViewMode | undefined;
  setViewMode?(mode: WorkLogViewMode): void;
  expansion?(): WorkLogsExpansion | undefined;
  setExpansion?(expansion: WorkLogsExpansion): void;
}

export interface WorkLogPresentationStoreProps {
  parts(): UiPart[];
  presentation?: WorkLogPresentationCapabilities;
}

export interface WorkLogTimerState {
  startedAt: number;
  endedAt?: number;
}

/** Owns work-log display preferences, disclosure overrides, and elapsed-time resources. */
export class WorkLogPresentationStore extends Store<WorkLogPresentationStoreProps> {
  private localViewMode: WorkLogViewMode = "auto";
  private localExpansion: WorkLogsExpansion = "collapsed";
  readonly itemOverrides = observable(new Map<string, boolean>());
  readonly groupOverrides = observable(new Map<string, boolean>());
  readonly timers = observable(new Map<string, WorkLogTimerState>());
  private tickNow = 0;
  private tickInterval: ReturnType<typeof setInterval> | undefined;

  constructor(props: WorkLogPresentationStore["props"]) {
    super(props);
    untracked(() => this.syncTimers());
    this.reaction(
      () =>
        this.props
          .parts()
          .flatMap((part) => (part.kind === "tool" ? [`${part.id}\u0000${part.state}`] : []))
          .join("\u0001"),
      () => this.syncTimers(),
    );
    this.effect(() => () => this.stopTick());
  }

  private get timingActive() {
    for (const timer of this.timers.values()) if (timer.endedAt === undefined) return true;
    return false;
  }

  syncTimers() {
    const now = Date.now();
    const parts = this.props.parts();
    const retainedPartIds = new Set<string>();
    for (const part of parts) {
      retainedPartIds.add(part.id);
      if (part.kind !== "tool") continue;
      const timer = this.timers.get(part.id);
      if (part.state === "running" || part.state === "approval") {
        if (!timer) this.timers.set(part.id, { startedAt: now });
      } else if (timer && timer.endedAt === undefined) {
        this.timers.set(part.id, { ...timer, endedAt: now });
      }
    }
    for (const partId of this.timers.keys()) {
      if (!retainedPartIds.has(partId)) this.timers.delete(partId);
    }
    for (const partId of this.itemOverrides.keys()) {
      if (!retainedPartIds.has(partId)) this.itemOverrides.delete(partId);
    }
    const retainedGroupIds = new Set(workLogGroupKeys(parts));
    for (const groupId of this.groupOverrides.keys()) {
      if (!retainedGroupIds.has(groupId)) this.groupOverrides.delete(groupId);
    }
    if (this.timingActive) this.startTick();
    else this.stopTick();
  }

  private startTick() {
    if (this.tickInterval !== undefined) return;
    this.tickNow = Date.now();
    this.tickInterval = setInterval(() => {
      this.tickNow = Date.now();
    }, 100);
  }

  private stopTick() {
    if (this.tickInterval === undefined) return;
    clearInterval(this.tickInterval);
    this.tickInterval = undefined;
  }

  elapsedMs(partId: string): number | undefined {
    const timer = this.timers.get(partId);
    if (!timer) return undefined;
    return Math.max(0, (timer.endedAt ?? this.tickNow) - timer.startedAt);
  }

  elapsedMsRange(startPartId: string, endPartId: string): number | undefined {
    const start = this.timers.get(startPartId);
    const end = this.timers.get(endPartId);
    if (!start) return this.elapsedMs(endPartId);
    return Math.max(0, (end?.endedAt ?? this.tickNow) - start.startedAt);
  }

  get viewMode(): WorkLogViewMode {
    return this.props.presentation?.viewMode?.() ?? this.localViewMode;
  }

  setViewMode(mode: WorkLogViewMode) {
    if (this.props.presentation?.setViewMode) this.props.presentation.setViewMode(mode);
    else this.localViewMode = mode;
  }

  cycleViewMode() {
    this.setViewMode(this.viewMode === "auto" ? "diff" : this.viewMode === "diff" ? "log" : "auto");
  }

  get expansion(): WorkLogsExpansion {
    return this.props.presentation?.expansion?.() ?? this.localExpansion;
  }

  setExpansion(expansion: WorkLogsExpansion) {
    if (this.props.presentation?.setExpansion) this.props.presentation.setExpansion(expansion);
    else this.localExpansion = expansion;
    this.itemOverrides.clear();
    this.groupOverrides.clear();
  }

  cycleExpansion() {
    this.setExpansion(
      this.expansion === "collapsed"
        ? "expanded"
        : this.expansion === "expanded"
          ? "fully-expanded"
          : "collapsed",
    );
  }

  groupOpen(groupId: string, hasDiff: boolean): boolean {
    const override = this.groupOverrides.get(groupId);
    if (override !== undefined) return override;
    if (this.expansion === "collapsed") return false;
    if (this.viewMode === "diff" && !hasDiff) return false;
    return true;
  }

  setGroupOpen(groupId: string, open: boolean) {
    this.groupOverrides.set(groupId, open);
  }

  itemOpen(partId: string): boolean {
    return this.itemOverrides.get(partId) ?? this.expansion === "fully-expanded";
  }

  setItemOpen(partId: string, open: boolean) {
    this.itemOverrides.set(partId, open);
  }
}
