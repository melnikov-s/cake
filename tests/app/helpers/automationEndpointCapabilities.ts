import { Effect, FileSystem, Layer, Path, Stream } from "effect";
import { HttpClient } from "effect/http";
import { ChildProcessSpawner } from "effect/process";
import {
  AutomationRecords,
  type AutomationRecordSnapshot,
} from "../../../src/services/automations/AutomationRecords";
import { AutomationConfiguration } from "../../../src/services/automations/AutomationConfiguration";
import { OptMemory } from "../../../src/services/opt-memory/OptMemory";

const empty: AutomationRecordSnapshot = {
  revision: 0,
  automations: [],
  occurrences: [],
  runs: [],
  artifactSchedules: [],
  pausedArtifactIds: [],
};

/** Complete endpoint membership for tests exercising other features. Mutation/memory calls fail loudly. */
export const unusedAutomationEndpointCapabilities = Layer.mergeAll(
  Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make(() => Effect.die("Unexpected artifact shell command")),
  ),
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make(() => Effect.die("Unexpected artifact network request")),
  ),
  Layer.mock(AutomationRecords, {
    snapshot: () => empty,
    changes: () => Stream.concat(Stream.succeed(empty), Stream.never),
  }),
  Layer.mock(OptMemory, {}),
  Layer.succeed(AutomationConfiguration, { homeDirectory: "/home/test" }),
  Layer.succeed(FileSystem.FileSystem, FileSystem.makeNoop({})),
  Path.layer,
);
