import { Layer } from "effect";
import { DiscussionTitleRequests } from "../../../src/services/discussion-sessions/DiscussionTitleRequests";
import { globalArtifactTestLayer } from "./globalArtifactTestLayer";
import { unusedAutomationEndpointCapabilities } from "./automationEndpointCapabilities";
import { PiSettings } from "../../../src/services/pi/PiSettings";
import { McpSettings } from "../../../src/services/pi/McpSettings";
import { WidgetPackages } from "../../../src/services/widgets/WidgetPackages";
import { SessionCoordination } from "../../../src/services/session-catalogs/SessionCoordination";
import { coordinationStorageHarness } from "./coordinationStorageHarness";
import { modelPresetPromptsTestLayer } from "./modelPresetPrompts";

/** Shared agent controls for session tests; unexpected external calls fail loudly. */
export const AgentControlTestLive = Layer.mergeAll(
  DiscussionTitleRequests.layer,
  modelPresetPromptsTestLayer,
  globalArtifactTestLayer,
  unusedAutomationEndpointCapabilities,
  SessionCoordination.layer.pipe(
    Layer.provide(Layer.suspend(() => coordinationStorageHarness().layer)),
  ),
  Layer.mock(PiSettings, {}),
  Layer.mock(McpSettings, {}),
  Layer.mock(WidgetPackages, { directory: "/test/widgets" }),
);
