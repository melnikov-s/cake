import type { Runtime } from "../runtime";
import type { DesktopSharingSettingsStore } from "../stores/DesktopSharingSettingsStore";

/** Window-owned current-first host projection, deliberately absent from browser bootstrap. */
export function observeDesktopSharing(runtime: Runtime, sharing: DesktopSharingSettingsStore) {
  return runtime.observe(
    (client) => client.desktopSharing.observe(),
    (state) => sharing.apply(state),
    {
      reportFailure: (error) => {
        sharing.error = error instanceof Error ? error.message : String(error);
      },
    },
  );
}
