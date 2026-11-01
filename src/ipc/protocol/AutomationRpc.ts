import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/unstable/rpc";
import {
  OptMemoryView,
  OptMemoryZoom,
  OptMemoryZoomInput,
} from "../../contracts/memory/opt-memory-data";
import {
  Automation,
  AutomationError,
  AutomationListInput,
} from "../../contracts/automations/automation-data";
import {
  AutomationArchiveInput,
  AutomationCatalogUpdate,
  AutomationCreateInput,
  AutomationHistoryInput,
  AutomationHistoryPage,
  AutomationInspection,
  AutomationListPage,
  AutomationOccurrenceTarget,
  AutomationRunTarget,
  AutomationTarget,
  AutomationTriggerInput,
  AutomationTriggerResult,
  AutomationUpdateInput,
} from "../../contracts/automations/automation-control";

/** Review skeleton: not registered in CakeRpc/BackendRpc until the backend slice is implemented. */
export const AutomationRpc = RpcGroup.make(
  Rpc.make("automations.observe", {
    success: AutomationCatalogUpdate,
    error: AutomationError,
    stream: true,
  }),
  Rpc.make("automations.list", {
    payload: AutomationListInput,
    success: AutomationListPage,
    error: AutomationError,
  }),
  Rpc.make("automations.inspect", {
    payload: AutomationTarget,
    success: AutomationInspection,
    error: AutomationError,
  }),
  Rpc.make("automations.create", {
    payload: AutomationCreateInput,
    success: Automation,
    error: AutomationError,
  }),
  Rpc.make("automations.update", {
    payload: AutomationUpdateInput,
    success: Automation,
    error: AutomationError,
  }),
  // Activate covers resume/restore after validating context, model and trigger configuration.
  Rpc.make("automations.activate", {
    payload: AutomationTarget,
    success: Automation,
    error: AutomationError,
  }),
  Rpc.make("automations.pause", {
    payload: AutomationTarget,
    success: Automation,
    error: AutomationError,
  }),
  Rpc.make("automations.archive", {
    payload: AutomationArchiveInput,
    success: Automation,
    error: AutomationError,
  }),
  Rpc.make("automations.trigger", {
    payload: AutomationTriggerInput,
    success: AutomationTriggerResult,
    error: AutomationError,
  }),
  Rpc.make("automations.history", {
    payload: AutomationHistoryInput,
    success: AutomationHistoryPage,
    error: AutomationError,
  }),
  Rpc.make("automations.cancelRun", {
    payload: AutomationRunTarget,
    error: AutomationError,
  }),
  Rpc.make("automations.cancelQueued", {
    payload: AutomationOccurrenceTarget,
    error: AutomationError,
  }),
  Rpc.make("automations.readMemory", {
    payload: AutomationTarget,
    success: OptMemoryView,
    error: AutomationError,
  }),
  Rpc.make("automations.zoomMemory", {
    payload: Schema.Struct({
      ...AutomationTarget.fields,
      range: OptMemoryZoomInput.fields.range,
      offset: OptMemoryZoomInput.fields.offset,
      maxChars: OptMemoryZoomInput.fields.maxChars,
    }),
    success: OptMemoryZoom,
    error: AutomationError,
  }),
);
