import { Effect } from "effect";
import * as modelPresets from "../../domain/model-presets/modelPresets";
import { Electron } from "../../services/electron/Electron";
import { makePiCallbackExecutor } from "../../services/pi/PiCallbackAdapter";
import { PiModels } from "../../services/pi/PiModels";
import { RendererRequestCoordinator } from "../../services/renderer-requests/RendererRequestCoordinator";
import { ModelRpc } from "../protocol/ModelRpc";
import { RendererConnection } from "../protocol/RendererConnectionMiddleware";

export const modelHandlers = ModelRpc.of({
  "models.list": () => Effect.flatMap(PiModels, (models) => models.list()),
  "models.refresh": () => Effect.flatMap(PiModels, (models) => models.refreshCatalog()),
  "models.login": ({ provider, authType }) =>
    Effect.gen(function* () {
      const models = yield* PiModels;
      const requests = yield* RendererRequestCoordinator;
      const electron = yield* Electron;
      const { connectionId } = yield* RendererConnection;
      const adapterContext = yield* Effect.context<RendererRequestCoordinator | Electron>();
      const runAdapter = makePiCallbackExecutor(adapterContext);
      const requestScopeId = `provider-settings:${connectionId}`;
      yield* models.login(provider, authType, {
        request: (request) =>
          runAdapter(
            requests.requestUiForConnection(connectionId, requestScopeId, {
              ...request,
              title: "Provider authentication",
            }),
          ),
        notify: (event) => {
          const message =
            event.type === "auth_url"
              ? (event.instructions ?? event.url)
              : event.type === "device_code"
                ? `${event.verificationUri}\nCode: ${event.userCode}`
                : event.message;
          electron.sendTo(electron.requireRendererConnection(connectionId), {
            type: "notification",
            tone: "info",
            title: "Authentication",
            message,
          });
          const url =
            event.type === "auth_url"
              ? event.url
              : event.type === "device_code"
                ? event.verificationUri
                : undefined;
          if (url) void runAdapter(electron.openExternal(url)).catch(() => undefined);
        },
      });
    }),
  "models.logout": ({ provider }) => Effect.flatMap(PiModels, (models) => models.logout(provider)),
  "modelPresets.list": () => modelPresets.list(),
  "modelPresets.create": (input) => modelPresets.create(input),
  "modelPresets.update": (input) => modelPresets.update(input),
  "modelPresets.reorder": (input) => modelPresets.reorder(input),
  "modelPresets.remove": ({ id }) => modelPresets.remove(id),
  "modelPresets.setDefault": ({ id }) => modelPresets.setDefault(id),
  "modelPresets.resolve": ({ id }) => modelPresets.resolve(id),
});
