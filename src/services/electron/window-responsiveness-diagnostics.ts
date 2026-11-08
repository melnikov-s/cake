import type { BrowserWindow, WebContentsDidStartNavigationEventParams } from "electron";
import { responsivenessRun } from "../diagnostics/responsiveness-diagnostics";

export interface WindowDiagnostic {
  readonly run: string;
  readonly windowId: number;
  readonly webContentsId: number;
  readonly connectionId: number;
  readonly rendererPid: number;
  readonly event: "unresponsive" | "responsive" | "render-gone";
  readonly timestamp: string;
  readonly durationMs?: number;
  readonly reason?: string;
  readonly exitCode?: number;
  readonly abnormal?: boolean;
}
const installed = new WeakMap<BrowserWindow, () => void>();

/** Use before an intentional native teardown; closing a healthy renderer is not a crash. */
export const disposeWindowResponsivenessDiagnostics = (window: BrowserWindow) =>
  installed.get(window)?.();

/** Window owns native listeners; no renderer RPC or timer is needed to report a stall. */
export function installWindowResponsivenessDiagnostics(
  window: BrowserWindow,
  connectionId: number,
  report: (record: WindowDiagnostic) => void,
  now: () => number = () => performance.now(),
) {
  const existing = installed.get(window);
  if (existing) return existing;
  const contents = window.webContents;
  const identity = {
    run: responsivenessRun,
    windowId: window.id,
    webContentsId: contents.id,
    connectionId,
  };
  let unresponsiveAt: number | undefined;
  let disposed = false;
  let rendererGone = false;
  const emit = (
    fields: Omit<WindowDiagnostic, keyof typeof identity | "timestamp" | "rendererPid">,
  ) => {
    if (disposed) return;
    report({
      ...identity,
      rendererPid: contents.getOSProcessId?.() ?? 0,
      timestamp: new Date().toISOString(),
      ...fields,
    });
  };
  const unresponsive = () => {
    if (unresponsiveAt !== undefined) return;
    unresponsiveAt = now();
    emit({ event: "unresponsive" });
  };
  const responsive = () => {
    if (unresponsiveAt === undefined) return;
    const durationMs = Math.max(0, now() - unresponsiveAt);
    unresponsiveAt = undefined;
    emit({ event: "responsive", durationMs });
  };
  const gone = (_event: Electron.Event, details: Electron.RenderProcessGoneDetails) => {
    if (rendererGone) return;
    rendererGone = true;
    // Only Electron's fixed reason vocabulary is retained, never renderer console bodies.
    const reason = [
      "clean-exit",
      "abnormal-exit",
      "killed",
      "crashed",
      "oom",
      "launch-failed",
      "integrity-failure",
      "memory-eviction",
    ].includes(details.reason)
      ? details.reason
      : "other";
    const fields = {
      event: "render-gone" as const,
      reason,
      exitCode: details.exitCode,
      abnormal: reason !== "clean-exit",
    };
    if (unresponsiveAt !== undefined)
      Object.assign(fields, { durationMs: Math.max(0, now() - unresponsiveAt) });
    emit(fields);
    unresponsiveAt = undefined;
  };
  const navigation = (event: Electron.Event<WebContentsDidStartNavigationEventParams>) => {
    if (event.isMainFrame && !event.isSameDocument) rendererGone = false;
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    window.removeListener("unresponsive", unresponsive);
    window.removeListener("responsive", responsive);
    window.removeListener("closed", dispose);
    contents.removeListener("render-process-gone", gone);
    contents.removeListener("destroyed", dispose);
    contents.removeListener("did-start-navigation", navigation);
    installed.delete(window);
  };
  installed.set(window, dispose);
  window.on("unresponsive", unresponsive);
  window.on("responsive", responsive);
  window.on("closed", dispose);
  contents.on("render-process-gone", gone);
  contents.on("destroyed", dispose);
  contents.on("did-start-navigation", navigation);
  return dispose;
}
