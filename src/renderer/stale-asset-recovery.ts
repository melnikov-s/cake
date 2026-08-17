const recoveryAttemptKey = "cake:stale-asset-recovery-attempt";
const recoveryWindowMs = 10_000;

export function installStaleAssetRecovery(reload: () => void = () => window.location.reload()) {
  const handlePreloadError = (event: VitePreloadErrorEvent) => {
    const previousAttempt = Number(window.sessionStorage.getItem(recoveryAttemptKey));
    if (Number.isFinite(previousAttempt) && Date.now() - previousAttempt < recoveryWindowMs) return;

    event.preventDefault();
    window.sessionStorage.setItem(recoveryAttemptKey, String(Date.now()));
    reload();
  };

  window.addEventListener("vite:preloadError", handlePreloadError);
  const clearAttempt = window.setTimeout(() => window.sessionStorage.removeItem(recoveryAttemptKey), recoveryWindowMs);

  return () => {
    window.clearTimeout(clearAttempt);
    window.removeEventListener("vite:preloadError", handlePreloadError);
  };
}
