import { FileSystem, Layer, Path, Stream } from "effect";
import {
  AutomationRecords,
  type AutomationRecordSnapshot,
} from "../../../src/services/automations/AutomationRecords";
import { CakeChatConfiguration } from "../../../src/services/pi-durable/CakeChatConfiguration";
import { OptMemory } from "../../../src/services/opt-memory/OptMemory";

const empty: AutomationRecordSnapshot = { revision: 0, automations: [], occurrences: [], runs: [] };

/** Complete endpoint membership for tests exercising other features. Mutation/memory calls fail loudly. */
export const unusedAutomationEndpointCapabilities = Layer.mergeAll(
  Layer.mock(AutomationRecords, {
    snapshot: () => empty,
    changes: () => Stream.concat(Stream.succeed(empty), Stream.never),
  }),
  Layer.mock(OptMemory, {}),
  Layer.succeed(CakeChatConfiguration, {
    agentDirectory: "/agent",
    location: { workingDirectory: "/home/test", sessionDirectory: "/chat" },
  }),
  Layer.succeed(FileSystem.FileSystem, FileSystem.makeNoop({})),
  Path.layer,
);
