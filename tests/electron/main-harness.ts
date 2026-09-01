import type { ElectronApplication } from "@playwright/test";
import type { PrivilegedEvent } from "../../src/ipc/privileged-contract";

/** Sends a validated native event through Cake's smoke-only main-process event source. */
export function emitRendererEvent(application: ElectronApplication, event: PrivilegedEvent) {
  return application.evaluate((_electron, input) => {
    const emit = (
      globalThis as typeof globalThis & {
        cakeSmokeEmitRendererEvent?: (event: PrivilegedEvent) => void;
      }
    ).cakeSmokeEmitRendererEvent;
    if (!emit) throw new Error("Cake smoke event source is unavailable");
    emit(input);
  }, event);
}
