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

/** The caller serializes this decision with recording the accepted occurrence. */
export function decideAdmission(input: AutomationAdmissionInput): AutomationAdmissionDecision {
  if (input.state._tag === "archived")
    return { action: "block", reason: "This automation is archived. Restore it before running." };
  if (input.state._tag === "suspended") return { action: "block", reason: input.state.reason };
  if (input.state._tag === "paused" && input.source !== "manual")
    return { action: "skip", reason: "This automation is paused." };
  if (input.runningSessions === 0 || input.overlap === "parallel") return { action: "start" };
  if (input.overlap === "queue") return { action: "queue" };
  return { action: "skip", reason: "An existing session of this automation is still running." };
}

/** Source kind comes from authoritative session/family metadata. All filters intersect. */
export function matchesEvent(filter: AutomationEventFilter, event: AutomationSourceEvent): boolean {
  return (
    filter.event === event.event &&
    filter.sessionKinds.includes(event.sourceKind) &&
    (filter.scope._tag !== "Global" || event.projectPath === undefined) &&
    (filter.scope._tag !== "Project" || filter.scope.projectPath === event.projectPath) &&
    (filter.sessionId === undefined || filter.sessionId === event.sourceSessionId) &&
    (filter.contentContains === undefined || event.text?.includes(filter.contentContains) === true)
  );
}
