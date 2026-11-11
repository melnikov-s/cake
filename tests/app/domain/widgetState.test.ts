import { it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { expect } from "vitest";
import { defaultApplicationState } from "../../../src/contracts/application/application-data";
import {
  ArtifactStateConflict,
  type ArtifactState,
} from "../../../src/contracts/artifacts/artifact-state";
import { ApplicationState } from "../../../src/services/storage/ApplicationState";
import { ApplicationStorage } from "../../../src/services/storage/ApplicationStorage";
import { ArtifactStorage } from "../../../src/services/storage/ArtifactStorage";
import { ClientEvents } from "../../../src/services/clients/ClientEvents";
import { widgetInstance } from "../helpers/widget-instance";
import * as attachments from "../../../src/domain/widgets/widgetAttachments";
import * as state from "../../../src/domain/widgets/widgetState";

it.effect(
  "requires explicit matching attachment scope, preserves CAS and shares one instance state across views",
  () => {
    const widget = widgetInstance();
    let current: ArtifactState = { lineageId: widget.revision.lineageId, version: 0, value: null };
    const notifications: string[] = [];
    const layer = Layer.mergeAll(
      ApplicationState.layer.pipe(
        Layer.provide(
          Layer.succeed(ApplicationStorage, {
            load: () =>
              Effect.succeed({ state: defaultApplicationState(), source: "missing" as const }),
            save: () => Effect.void,
          }),
        ),
      ),
      Layer.mock(ArtifactStorage, {
        read: () => Effect.succeed(widget.revision),
        readState: () => Effect.succeed(current),
        replaceState: (input) =>
          Effect.gen(function* () {
            if (input.expectedVersion !== current.version)
              return yield* new ArtifactStateConflict({
                lineageId: input.lineageId,
                expectedVersion: input.expectedVersion,
                actualVersion: current.version,
              });
            current = {
              lineageId: input.lineageId,
              version: current.version + 1,
              value: input.value,
            };
            return current;
          }),
      }),
      Layer.mock(ClientEvents, {
        sendTo: () => false,
        broadcast: (event) => notifications.push(event.type),
      }),
    );
    return Effect.gen(function* () {
      yield* (yield* ApplicationState).initialize();
      const scope = { attachmentId: "one", lineageId: widget.revision.lineageId };
      expect((yield* Effect.result(state.read(scope)))._tag).toBe("Failure");
      yield* attachments.attach({
        id: "one",
        lineageId: scope.lineageId,
        slot: "top",
        target: { kind: "global" },
      });
      yield* attachments.attach({
        id: "two",
        lineageId: scope.lineageId,
        slot: "bottom",
        target: { kind: "global" },
      });
      yield* state.replace({ ...scope, expectedVersion: 0, value: { selected: "saved" } });
      expect((yield* state.read({ ...scope, attachmentId: "two" })).value).toEqual({
        selected: "saved",
      });
      expect(
        (yield* Effect.result(state.replace({ ...scope, expectedVersion: 0, value: "stale" })))
          ._tag,
      ).toBe("Failure");
      yield* attachments.detach("one");
      expect((yield* Effect.result(state.read(scope)))._tag).toBe("Failure");
      expect((yield* state.read({ ...scope, attachmentId: "two" })).value).toEqual({
        selected: "saved",
      });
      expect(notifications).toEqual(["artifact-state-invalidated"]);
    }).pipe(Effect.provide(layer));
  },
);
