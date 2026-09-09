import { Effect, Stream } from "effect";
import { getState, observeState } from "../../domain/application/application";
import { AgentAvailability } from "../../services/pi/AgentAvailability";
import { ApplicationRpc } from "../protocol/ApplicationRpc";

export const applicationStateHandlers = ApplicationRpc.of({
  "application.getState": () => getState(),
  "application.observeState": () => Stream.unwrap(observeState()),
  "application.observeAgentAvailability": () =>
    Stream.unwrap(Effect.map(AgentAvailability, (availability) => availability.changes())),
});
