import { readFileSync, existsSync } from "node:fs";
import { mkdir, writeFile, rename } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { dialog, session, type App } from "electron";
import { Effect, Layer, Schema, Semaphore } from "effect";
import {
  DesktopHostError,
  DesktopHostSelection,
  normalizeServerUrl,
} from "../../domain/application/desktop-host-data";
import { DesktopHost } from "./DesktopHost";

const hostFile = (directory: string) => join(directory, "desktop-host.json");
export function loadDesktopHost(directory: string): DesktopHostSelection {
  if (!existsSync(hostFile(directory))) return { kind: "local" };
  const selected = Schema.decodeUnknownSync(DesktopHostSelection)(
    JSON.parse(readFileSync(hostFile(directory), "utf8")),
  );
  return selected.kind === "remote"
    ? { kind: "remote", url: normalizeServerUrl(selected.url) }
    : selected;
}
export function desktopPresentationDirectory(directory: string, host: DesktopHostSelection) {
  return host.kind === "local"
    ? directory
    : join(directory, "remote-hosts", createHash("sha256").update(host.url).digest("hex"));
}

/** Host selection is device-local, process-wide and takes effect only after deliberate relaunch. */
export const makeDesktopHostLive = (
  application: App,
  directory: string,
  selected: DesktopHostSelection,
) =>
  Layer.effect(
    DesktopHost,
    Effect.gen(function* () {
      const lock = yield* Semaphore.make(1);
      return DesktopHost.of({
        current: () => selected,
        select: Effect.fn("DesktopHost.select")((input) =>
          lock.withPermits(1)(
            Effect.tryPromise({
              try: async () => {
                const next =
                  input.kind === "remote"
                    ? { kind: "remote" as const, url: normalizeServerUrl(input.url) }
                    : input;
                const result = await dialog.showMessageBox({
                  type: "warning",
                  buttons: ["Cancel", "Relaunch Cake"],
                  defaultId: 0,
                  cancelId: 0,
                  message: "Change Cake backend and relaunch?",
                  detail:
                    "Local agent work and browser sharing stop when this process quits. Remote accepted work continues on its server. Drafts and window state are kept separately for each host. Wait for local work to finish before continuing.",
                });
                if (result.response !== 1) return false;
                await mkdir(directory, { recursive: true });
                await writeFile(`${hostFile(directory)}.tmp`, JSON.stringify(next), "utf8");
                await rename(`${hostFile(directory)}.tmp`, hostFile(directory));
                application.relaunch();
                application.quit();
                return true;
              },
              catch: (cause) =>
                new DesktopHostError({
                  message: cause instanceof Error ? cause.message : "Could not select backend",
                }),
            }),
          ),
        ),
      });
    }),
  );

/** Native sockets deliberately use the server's missing-Origin opt-in. Never relax browser checks.
 * Restrict rewriting to this process's selected endpoint and WebSocket resource type. */
export function installDesktopSocketOrigin(host: DesktopHostSelection) {
  if (host.kind !== "remote") return;
  session.defaultSession.webRequest.onBeforeSendHeaders(
    { urls: [host.url] },
    (details, callback) => {
      const headers = { ...details.requestHeaders };
      if (details.resourceType === "webSocket" && details.url === host.url)
        for (const name of Object.keys(headers))
          if (name.toLowerCase() === "origin") delete headers[name];
      callback({ requestHeaders: headers });
    },
  );
}
