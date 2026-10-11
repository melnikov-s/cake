import { Effect, SubscriptionRef } from "effect";
import { WorkflowSupervisor } from "../../services/workflows/WorkflowSupervisor";

export const holdsTurnCompletion = Effect.fn("Workflows.holdsTurnCompletion")(function* (
  sessionId: string,
  turnId: string,
) {
  const supervisor = yield* WorkflowSupervisor;
  return [...(yield* SubscriptionRef.get(supervisor.state)).values()].some(
    ({ checkpoint }) =>
      checkpoint.run.ownerSessionId === sessionId && checkpoint.completionTurnIds.includes(turnId),
  );
});

export const hasActive = Effect.fn("Workflows.hasActive")(function* (target: {
  readonly sessionId?: string;
  readonly workingDirectory?: string;
}) {
  const supervisor = yield* WorkflowSupervisor;
  return [...(yield* SubscriptionRef.get(supervisor.state)).values()].some(
    ({ checkpoint }) =>
      ["running", "paused", "stopping"].includes(checkpoint.run.status) &&
      (target.sessionId === undefined || checkpoint.run.ownerSessionId === target.sessionId) &&
      (target.workingDirectory === undefined ||
        checkpoint.run.workingDirectory === target.workingDirectory),
  );
});
export const holdsCompletion = Effect.fn("Workflows.holdsCompletion")(function* (
  sessionId: string,
  turnId?: string,
) {
  const supervisor = yield* WorkflowSupervisor;
  return [...(yield* SubscriptionRef.get(supervisor.state)).values()].some(
    ({ checkpoint }) =>
      checkpoint.run.ownerSessionId === sessionId &&
      (turnId === undefined || checkpoint.completionTurnIds.includes(turnId)) &&
      (["running", "paused", "stopping"].includes(checkpoint.run.status) ||
        (["complete", "error", "stopped"].includes(checkpoint.run.status) &&
          checkpoint.completionDelivery === "pending")),
  );
});
