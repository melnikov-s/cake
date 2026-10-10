import {
  defaultProjectSettings,
  defaultProjectWorkflow,
  type ProjectRecord,
  type ProjectWorkflow,
} from "../../../../src/contracts/application/application-data";

export const fixtureTimestamp = "2026-01-01T00:00:00.000Z";

export interface SessionSummaryFixture {
  readonly sessionId: string;
  readonly title: string;
  readonly createdAt: string;
  readonly modifiedAt: string;
  readonly messageCount: number;
  readonly resolved: boolean;
  readonly unread: boolean;
  readonly projectPath: string;
  readonly projectName: string;
  readonly workingDirectory: string;
  readonly familyId?: string;
  readonly familyParentSessionId?: string;
  readonly familyChildSessionIds?: readonly string[];
  readonly familyChildOrder?: number;
  readonly familyDepth?: number;
  readonly pending: boolean;
  readonly draft: boolean;
}

export function projectRecord(
  input: {
    readonly path: string;
    readonly name?: string;
    readonly workflow?: ProjectWorkflow;
  } & Partial<Pick<ProjectRecord, "addedAt" | "lastOpenedAt" | "settings">>,
): ProjectRecord {
  return {
    path: input.path,
    name: input.name ?? input.path.split("/").at(-1) ?? input.path,
    addedAt: input.addedAt ?? fixtureTimestamp,
    lastOpenedAt: input.lastOpenedAt ?? fixtureTimestamp,
    settings: input.settings ?? defaultProjectSettings(),
    workflow: input.workflow ?? defaultProjectWorkflow(),
  };
}

export function sessionSummary(
  input: {
    readonly sessionId: string;
    readonly projectPath: string;
    readonly projectName?: string;
    readonly workingDirectory?: string;
  } & Partial<
    Omit<SessionSummaryFixture, "sessionId" | "projectPath" | "projectName" | "workingDirectory">
  >,
): SessionSummaryFixture {
  return {
    sessionId: input.sessionId,
    title: input.title ?? input.sessionId,
    createdAt: input.createdAt ?? fixtureTimestamp,
    modifiedAt: input.modifiedAt ?? fixtureTimestamp,
    messageCount: input.messageCount ?? 0,
    resolved: input.resolved ?? false,
    unread: input.unread ?? false,
    projectPath: input.projectPath,
    projectName: input.projectName ?? input.projectPath.split("/").at(-1) ?? input.projectPath,
    workingDirectory: input.workingDirectory ?? input.projectPath,
    ...(input.familyId === undefined ? null : { familyId: input.familyId }),
    ...(input.familyParentSessionId === undefined
      ? null
      : { familyParentSessionId: input.familyParentSessionId }),
    ...(input.familyChildSessionIds === undefined
      ? null
      : { familyChildSessionIds: input.familyChildSessionIds }),
    ...(input.familyChildOrder === undefined ? null : { familyChildOrder: input.familyChildOrder }),
    ...(input.familyDepth === undefined ? null : { familyDepth: input.familyDepth }),
    pending: input.pending ?? false,
    draft: input.draft ?? false,
  };
}
