import { Effect, Schema, SubscriptionRef } from "effect";
import { ManagedWorktrees } from "../services/worktrees/ManagedWorktrees";
import { WorktreeLandingCoordinator } from "../services/worktrees/WorktreeLandingCoordinator";

const Input = Schema.Struct({
  ownerWorkspace: Schema.String,
  waitingWorkspace: Schema.String,
  ownerSession: Schema.String,
  waitingSession: Schema.String,
});

const services = Effect.fn("Smoke.landingServices")(function* () {
  const worktrees = yield* Effect.serviceOption(ManagedWorktrees);
  const coordinator = yield* Effect.serviceOption(WorktreeLandingCoordinator);
  if (worktrees._tag === "None" || coordinator._tag === "None")
    return yield* Effect.die("Local-only landing fixture");
  return { worktrees: worktrees.value, coordinator: coordinator.value };
});

/** Installed only by the existing local smoke branch. Reserves real FIFO entries, but never
 * invokes land, Git mutations, prompts or session resolution. The conflict phase is synthetic.
 */
export function installLandingSmokeFixture(run: <A, E>(effect: Effect.Effect<A, E>) => Promise<A>) {
  let active: { workspacePath: string; operationId: string }[] = [];
  Object.assign(globalThis, {
    cakeSmokeReserveLanding(input: typeof Input.Type) {
      return run(
        Effect.gen(function* () {
          const value = yield* Schema.decodeUnknownEffect(Input)(input);
          if (active.length) return yield* Effect.die("Landing fixture already active");
          const { worktrees, coordinator } = yield* services();
          const owner = {
            workspacePath: value.ownerWorkspace,
            operationId: crypto.randomUUID(),
            sessionId: value.ownerSession,
            kind: "landing" as const,
            phase: "resolving" as const,
            pauseReason: "conflict" as const,
            allowDirtyTarget: false,
          };
          const waiter = {
            workspacePath: value.waitingWorkspace,
            operationId: crypto.randomUUID(),
            sessionId: value.waitingSession,
            kind: "landing" as const,
            phase: "queued" as const,
            allowDirtyTarget: false,
          };
          yield* worktrees.prepareLanding(owner.workspacePath, owner.operationId);
          active = [owner];
          yield* worktrees.prepareLanding(waiter.workspacePath, waiter.operationId);
          active = [owner, waiter];
          yield* SubscriptionRef.update(coordinator.state, (state) => ({
            ...state,
            operations: new Map(state.operations)
              .set(owner.workspacePath, owner)
              .set(waiter.workspacePath, waiter),
          }));
          return { owner: owner.operationId, waiter: waiter.operationId };
        }),
      );
    },
    cakeSmokeClearLanding() {
      return run(
        Effect.gen(function* () {
          const { worktrees, coordinator } = yield* services();
          for (const item of [...active].reverse())
            yield* worktrees.cancelLanding(item.workspacePath, item.operationId);
          yield* SubscriptionRef.update(coordinator.state, (state) => {
            const operations = new Map(state.operations);
            for (const item of active)
              if (operations.get(item.workspacePath)?.operationId === item.operationId)
                operations.delete(item.workspacePath);
            return { ...state, operations };
          });
          active = [];
        }),
      );
    },
  });
}
