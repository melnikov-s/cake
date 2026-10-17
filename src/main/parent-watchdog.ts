interface WatchedProcess {
  readonly ppid: number;
}

/**
 * Calls `orphaned` once when this process's original parent dies.
 *
 * Playwright launches Electron as its own process-group leader and kills it only from the
 * runner's exit handlers, so a SIGKILLed runner leaves Cake running under PID 1. A dead
 * parent is observable as a changed `ppid`, because the OS reparents the orphan.
 */
export function installParentProcessWatchdog(
  process: WatchedProcess,
  orphaned: () => void,
  intervalMs = 1_000,
) {
  const parent = process.ppid;
  const check = () => {
    if (parent > 1 && process.ppid === parent) return false;
    clearInterval(timer);
    orphaned();
    return true;
  };
  const timer = setInterval(check, intervalMs);
  timer.unref();
  check();
  return () => clearInterval(timer);
}
