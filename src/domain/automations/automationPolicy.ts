import type {
  AutomationDefinition,
  AutomationEventFilter,
  AutomationSourceEvent,
  AutomationState,
} from "../../contracts/automations/automation-data";

export interface AutomationAdmissionInput {
  readonly state: AutomationState;
  readonly overlap: AutomationDefinition["overlap"];
  readonly runningSessions: number;
  readonly source: "manual" | "schedule" | "event";
}

export type AutomationAdmissionDecision =
  | { readonly action: "start" }
  | { readonly action: "queue" }
  | { readonly action: "skip"; readonly reason: string }
  | { readonly action: "block"; readonly reason: string };

/**
 * REVIEW SKELETON ONLY. Not connected to runtime callers.
 * The backend admission operation applies this policy while serializing admission per automation.
 * Paused automatic triggers are skipped without replay; manual triggers remain possible.
 * Suspended/archived definitions block execution; overlap is scoped to automationId.
 */
export function decideAdmission(input: AutomationAdmissionInput): AutomationAdmissionDecision {
  throw new Error(
    `Automation ${input.source} admission is not implemented: contract review skeleton`,
  );
}

/**
 * REVIEW SKELETON ONLY. Source kinds come from authoritative session/family metadata,
 * not renderer state, creator links, or a missing parent ID. All supplied filters intersect.
 */
export function matchesEvent(filter: AutomationEventFilter, event: AutomationSourceEvent): boolean {
  throw new Error(
    `Automation event matching (${filter.event}, ${event.event}) is not implemented: contract review skeleton`,
  );
}
