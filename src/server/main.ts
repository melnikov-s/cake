import { NodeRuntime } from "@effect/platform-node-shared";
import { Config, Effect, Layer, Schema } from "effect";
import { isAbsolute } from "node:path";
import { homedir } from "node:os";
import * as cakeChatLocations from "../domain/cake-chats/cakeChatLocations";
import { openNetworkListener } from "./NetworkListener";
import { networkConfiguration } from "./networkConfiguration";
import { makeBackendLive } from "../backend/BackendLive";
import { PreviewLeases } from "../services/browser/PreviewLeases";
import { resolveCakePaths } from "../config/CakePaths";
import { piAgentDirectory } from "../services/pi/PiPaths";
import { BootstrapLive } from "../main/BootstrapLive";
import { makeBackendLoggingLive } from "../services/diagnostics/BackendLoggingLive";

// The network endpoint is explicitly opt-in. CAKE_HOME selects Cake metadata;
// Pi independently resolves credentials/configuration through PI_CODING_AGENT_DIR.
const program = Effect.gen(function* () {
  const home = yield* Config.schema(
    Schema.NonEmptyString.check(
      Schema.makeFilter(isAbsolute, { message: "CAKE_HOME must be an absolute path" }),
    ),
    "CAKE_HOME",
  );
  const network = yield* networkConfiguration();
  const paths = resolveCakePaths({
    env: { CAKE_HOME: home },
    piAgentDirectory: piAgentDirectory(),
  });
  const homeDirectory = homedir();
  const logging = makeBackendLoggingLive(paths.logs, "server").pipe(Layer.provide(BootstrapLive));
  const backend = makeBackendLive(
    { paths, homeDirectory, remoteCapture: true },
    () => Layer.empty,
  ).pipe(Layer.provideMerge(logging));
  yield* Effect.gen(function* () {
    if (network) {
      const previews = yield* PreviewLeases;
      const listener = yield* openNetworkListener(
        network,
        {
          homeDirectory,
          cakeChat: {
            agentDirectory: paths.piAgent,
            location: cakeChatLocations.make({
              homeDirectory,
              sessionDirectory: paths.cakeChat,
            }),
          },
        },
        previews,
      );
      yield* Effect.logWarning(
        "Unauthenticated Cake endpoint: accepted clients have full backend authority",
      );
      const address = listener.address;
      if (address._tag === "TcpAddress") {
        const hostname = address.hostname.includes(":")
          ? `[${address.hostname}]`
          : address.hostname;
        yield* Effect.logInfo(
          `Cake headless RPC listening at ws://${hostname}:${address.port}${listener.path}`,
        );
        if (network.browserAssetsDirectory) {
          yield* Effect.logInfo(`Cake browser chat at http://${hostname}:${address.port}/`);
          if (listener.editorPort !== undefined)
            yield* Effect.logInfo(
              `Cake isolated editor at http://${hostname}:${listener.editorPort}/`,
            );
        }
      }
      yield* Effect.logInfo("Cake headless backend ready");
    } else {
      yield* Effect.logInfo("Cake headless backend ready (no network listener)");
    }
    yield* Effect.never;
  }).pipe(
    Effect.ensuring(Effect.logInfo("Cake headless backend stopped")),
    Effect.scoped,
    Effect.provide(backend),
  );
});

// Owns the process Scope, interrupts workers/turns, and awaits all resource
// finalizers before exiting on SIGINT or SIGTERM.
NodeRuntime.runMain(program);
