import { Effect, Stream } from "effect";
import { PluginRpc } from "../protocol/PluginRpc";
import { RendererConnection } from "../protocol/RendererConnectionMiddleware";
import { NativeEvents } from "../../services/electron/NativeEvents";
import { PluginRuntime } from "../../services/plugins/PluginRuntime";
import type { PluginRuntimeError } from "../../services/plugins/PluginRuntime";

const withConnection = <A, E, R>(operation: (connectionId: number) => Effect.Effect<A, E, R>) =>
  Effect.flatMap(RendererConnection, ({ connectionId }) => operation(connectionId));

const operation =
  <Payload, Success>(
    execute: (
      service: PluginRuntime["Service"],
      connectionId: number,
      request: Payload,
    ) => Effect.Effect<Success, PluginRuntimeError>,
  ) =>
  (request: Payload) =>
    withConnection((connectionId) =>
      Effect.flatMap(PluginRuntime, (service) => execute(service, connectionId, request)),
    );

export const pluginHandlers = PluginRpc.of({
  "plugins.get-customization-state": operation((service, connectionId, request) =>
    service["get-customization-state"](connectionId, request),
  ),
  "plugins.observeCustomization": () =>
    Stream.unwrap(Effect.map(PluginRuntime, (service) => service.customizationChanges())),
  "plugins.get-plugin-authoring-reference": operation((service, connectionId, request) =>
    service["get-plugin-authoring-reference"](connectionId, request),
  ),
  "plugins.list-plugin-files": operation((service, connectionId, request) =>
    service["list-plugin-files"](connectionId, request),
  ),
  "plugins.create-plugin": operation((service, connectionId, request) =>
    service["create-plugin"](connectionId, request),
  ),
  "plugins.read-plugin-file": operation((service, connectionId, request) =>
    service["read-plugin-file"](connectionId, request),
  ),
  "plugins.write-plugin-file": operation((service, connectionId, request) =>
    service["write-plugin-file"](connectionId, request),
  ),
  "plugins.validate-customization": operation((service, connectionId, request) =>
    service["validate-customization"](connectionId, request),
  ),
  "plugins.activate-customization": operation((service, connectionId, request) =>
    service["activate-customization"](connectionId, request),
  ),
  "plugins.rollback-customization": operation((service, connectionId, request) =>
    service["rollback-customization"](connectionId, request),
  ),
  "plugins.use-factory-customization": operation((service, connectionId, request) =>
    service["use-factory-customization"](connectionId, request),
  ),
  "plugins.list-plugins": operation((service, connectionId, request) =>
    service["list-plugins"](connectionId, request),
  ),
  "plugins.set-plugin-enabled": operation((service, connectionId, request) =>
    service["set-plugin-enabled"](connectionId, request),
  ),
  "plugins.set-active-scene": operation((service, connectionId, request) =>
    service["set-active-scene"](connectionId, request),
  ),
  "plugins.delete-plugin": operation((service, connectionId, request) =>
    service["delete-plugin"](connectionId, request),
  ),
  "plugins.compile-inline-widget": operation((service, connectionId, request) =>
    service["compile-inline-widget"](connectionId, request),
  ),
  "plugins.repair-inline-widget": operation((service, connectionId, request) =>
    service["repair-inline-widget"](connectionId, request),
  ),
  "plugins.open-plugin-agent": operation((service, connectionId, request) =>
    service["open-plugin-agent"](connectionId, request),
  ),
  "plugins.prompt-plugin-agent": operation((service, connectionId, request) =>
    service["prompt-plugin-agent"](connectionId, request),
  ),
  "plugins.abort-plugin-agent": operation((service, connectionId, request) =>
    service["abort-plugin-agent"](connectionId, request),
  ),
  "plugins.detach-plugin-agent": operation((service, connectionId, request) =>
    service["detach-plugin-agent"](connectionId, request),
  ),
  "plugins.run-plugin-completion": operation((service, connectionId, request) =>
    service["run-plugin-completion"](connectionId, request),
  ),
  "plugins.cancel-plugin-completion": operation((service, connectionId, request) =>
    service["cancel-plugin-completion"](connectionId, request),
  ),
  "plugins.load-plugin-state": operation((service, connectionId, request) =>
    service["load-plugin-state"](connectionId, request),
  ),
  "plugins.save-plugin-state": operation((service, connectionId, request) =>
    service["save-plugin-state"](connectionId, request),
  ),
  "plugins.call-plugin-backend": operation((service, connectionId, request) =>
    service["call-plugin-backend"](connectionId, request),
  ),
  "plugins.cancel-plugin-backend-call": operation((service, connectionId, request) =>
    service["cancel-plugin-backend-call"](connectionId, request),
  ),
  "plugins.customization-rendered": operation((service, connectionId, request) =>
    service["customization-rendered"](connectionId, request),
  ),
  "plugins.customization-runtime-failed": operation((service, connectionId, request) =>
    service["customization-runtime-failed"](connectionId, request),
  ),
  "plugins.observeEvents": () =>
    Stream.unwrap(
      Effect.gen(function* () {
        const connection = yield* RendererConnection;
        return (yield* NativeEvents).plugins(connection.connectionId);
      }),
    ),
});
