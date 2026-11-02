import { Schema } from "effect";
import {
  AutomationId,
  AutomationRunId,
  AutomationOccurrenceId,
  type AutomationDefinition,
  type Automation,
  type AutomationRun,
  type AutomationOccurrence,
  type AutomationSummary,
  type AutomationSessionSummary,
} from "../../../../src/contracts/automations/automation-data";
import { OptMemoryId } from "../../../../src/contracts/memory/opt-memory-data";

export const automationId = Schema.decodeUnknownSync(AutomationId)(
  "10000000-0000-4000-8000-000000000001",
);
export const secondAutomationId = Schema.decodeUnknownSync(AutomationId)(
  "10000000-0000-4000-8000-000000000002",
);
export const runId = Schema.decodeUnknownSync(AutomationRunId)(
  "20000000-0000-4000-8000-000000000001",
);
export const occurrenceId = Schema.decodeUnknownSync(AutomationOccurrenceId)(
  "30000000-0000-4000-8000-000000000001",
);
const timestamp = "2030-01-01T09:00:00.000Z";

export function automationDefinition(
  overrides: Partial<AutomationDefinition> = {},
): AutomationDefinition {
  return {
    name: "Daily review",
    context: { _tag: "Global" },
    trigger: {
      _tag: "Schedule",
      schedule: { _tag: "Interval", startsAt: timestamp, everySeconds: 86400 },
    },
    task: {
      prompt: "Review open work",
      configuration: { provider: "test", modelId: "test", thinkingLevel: "off", fastMode: false },
      attachments: [],
    },
    overlap: "queue",
    completion: "keep-for-review",
    ...overrides,
  };
}
export function automation(overrides: Partial<Automation> = {}): Automation {
  return {
    id: automationId,
    definition: automationDefinition(),
    state: { _tag: "active" },
    memoryId: Schema.decodeUnknownSync(OptMemoryId)("40000000-0000-4000-8000-000000000001"),
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  };
}
export function automationSummary(overrides: Partial<AutomationSummary> = {}): AutomationSummary {
  return {
    id: automationId,
    name: "Daily review",
    context: { _tag: "Global" },
    state: { _tag: "active" },
    activity: { runningSessions: 2, queuedOccurrences: 3 },
    ...overrides,
  };
}
export function automationRun(overrides: Partial<AutomationRun> = {}): AutomationRun {
  return {
    id: runId,
    automationId,
    occurrenceId,
    sessionId: "automation-run-1",
    context: { _tag: "Global" },
    workingDirectory: "/home/user",
    sessionDirectory: "/sessions/automations",
    startedAt: timestamp,
    status: { _tag: "running" },
    ...overrides,
  };
}
export function automationOccurrence(
  overrides: Partial<AutomationOccurrence> = {},
): AutomationOccurrence {
  return {
    id: occurrenceId,
    automationId,
    source: { _tag: "Manual" },
    occurredAt: timestamp,
    definition: automationDefinition(),
    disposition: { _tag: "started", runId },
    ...overrides,
  };
}
export function automationSession(
  overrides: Partial<AutomationSessionSummary> = {},
): AutomationSessionSummary {
  const run = automationRun();
  return {
    identity: {
      _tag: "AutomationSession",
      sessionId: run.sessionId,
      automationId,
      runId,
      context: run.context,
      workingDirectory: run.workingDirectory,
    },
    title: "Daily review",
    createdAt: timestamp,
    modifiedAt: timestamp,
    resolved: false,
    unread: false,
    running: true,
    ...overrides,
  };
}
