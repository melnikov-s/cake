import { FileSystem, Layer, Path, Stream } from "effect";
import {
  AutomationRecords,
  type AutomationRecordSnapshot,
} from "../../../src/services/automations/AutomationRecords";
import { AutomationConfiguration } from "../../../src/services/automations/AutomationConfiguration";
import { OptMemory } from "../../../src/services/opt-memory/OptMemory";

const empty: AutomationRecordSnapshot = { revision: 0, automations: [], occurrences: [], runs: [] };

/** Complete endpoint membership for tests exercising other features. Mutation/memory calls fail loudly. */
export const unusedAutomationEndpointCapabilities = Layer.mergeAll(
  Layer.mock(AutomationRecords, {
    snapshot: () => empty,
    changes: () => Stream.concat(Stream.succeed(empty), Stream.never),
  }),
  Layer.mock(OptMemory, {}),
  Layer.succeed(AutomationConfiguration, { homeDirectory: "/home/test" }),
  Layer.succeed(FileSystem.FileSystem, FileSystem.makeNoop({})),
  Path.layer,
);
