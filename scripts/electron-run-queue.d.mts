export function electronQueuePath(): string;
export interface ElectronQueueState {
  capacity: number;
  running: number;
  queued: number;
}
export function electronQueueState(queuePath?: string, validation?: boolean): ElectronQueueState;
export function setElectronQueueCapacity(
  capacity: number,
  queuePath?: string,
  validation?: boolean,
): ElectronQueueState;
export function isElectronRun(): boolean;
export function queueElectronEntrypoint(options?: { timeoutMs?: number }): Promise<void>;
export interface ElectronQueueEvent {
  type: "queued" | "running" | "result";
  id?: number;
  position?: number;
  code?: number;
  capacity?: number;
  running?: number;
  queued?: number;
}
export function runElectronCommand(
  command: string,
  args: string[],
  options?: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    /** Positive milliseconds, or Infinity for interactive apps. Default 30 minutes. */
    timeoutMs?: number;
    signal?: AbortSignal;
    /** Isolated database for process tests only; production uses the machine path. */
    queuePath?: string;
    onEvent?: (event: ElectronQueueEvent) => void;
    /** Internal Cake validation policy; shares supervision, not Electron capacity. */
    validation?: { priority: number; label: string };
  },
): Promise<number>;
