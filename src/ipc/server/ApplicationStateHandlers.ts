import { Effect, Stream } from "effect";
import {
  deleteSessionPlugin,
  getState,
  observeState,
  setSessionPluginSharedState,
  setSessionPluginState,
} from "../../domain/application/application";
import { AgentAvailability } from "../../services/pi/AgentAvailability";
import { ApplicationRpc, SessionPluginMutationError } from "../protocol/ApplicationRpc";

const pluginMutationError = Effect.mapError(
  (cause: unknown) =>
    new SessionPluginMutationError({
      message: cause instanceof Error ? cause.message : String(cause),
    }),
);

export const applicationStateHandlers = ApplicationRpc.of({
  "application.getState": () => getState(),
  "application.observeState": () => Stream.unwrap(observeState()),
  "application.observeAgentAvailability": () =>
    Stream.unwrap(Effect.map(AgentAvailability, (availability) => availability.changes())),
  "application.setSessionPluginState": ({ sessionId, pluginId, state }) =>
    setSessionPluginState(sessionId, pluginId, state).pipe(Effect.asVoid, pluginMutationError),
  "application.setSessionPluginSharedState": ({ sessionId, key, value }) =>
    setSessionPluginSharedState(sessionId, key, value).pipe(Effect.asVoid, pluginMutationError),
  "application.deleteSessionPlugin": ({ sessionId, pluginId }) =>
    deleteSessionPlugin(sessionId, pluginId).pipe(Effect.asVoid, pluginMutationError),
});
