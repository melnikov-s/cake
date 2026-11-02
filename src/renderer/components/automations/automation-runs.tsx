import { observer, useStore } from "r-state-tree/react";
import { RootStore } from "../../stores/RootStore";
import { Button } from "../ui/button";
import { Callout } from "../ui/callout";
import { LoadingState } from "../ui/loading-state";
import { SessionIdLink } from "../ui/session-id-link";
import { MarkdownLink } from "../ai-elements/markdown";
import { messageReference } from "../../../contracts/conversations/message-reference";

export const AutomationRuns = observer(function AutomationRuns() {
  const root = useStore(RootStore);
  const history = root.automationsStore.history;
  const global = root.automationsStore.globalHistory;
  return (
    <section className="min-h-0 flex-1 overflow-auto px-8 py-7" aria-label="Automation run history">
      <header className="mb-6 flex items-center justify-between gap-3">
        <h2 className="font-display text-xl font-semibold">
          {global ? "Automation history" : "Run history"}
        </h2>
        <Button variant="outline" disabled={history.loading} onClick={() => void history.load()}>
          Refresh
        </Button>
      </header>
      {history.error && (
        <Callout variant="error" role="alert">
          {history.error}
        </Callout>
      )}
      {history.loading && <LoadingState label="Reading run history" />}
      <div className="overflow-auto">
        <table className="w-full min-w-[600px] text-left text-xs">
          <thead className="text-muted-foreground">
            <tr>
              {["Time", ...(global ? ["Automation"] : []), "Source", "Outcome", "Session", ""].map(
                (label) => (
                  <th key={label} className="border-b border-border/65 pb-3 pr-4 font-normal">
                    {label}
                  </th>
                ),
              )}
            </tr>
          </thead>
          <tbody>
            {history.occurrences.map((occurrence) => {
              const startedRunId =
                occurrence.disposition._tag === "started"
                  ? occurrence.disposition.runId
                  : undefined;
              const run = history.runs.find((run) => run.id === startedRunId);
              const summary =
                run &&
                root.props.projection.automations.unresolvedSessions.find(
                  (session) => session.sessionId === run.sessionId,
                );
              const resolved = run && root.automationSessionsStore.isResolved(run.sessionId);
              return (
                <tr key={occurrence.id} className="border-b border-border/65">
                  <td className="py-4 pr-4">{new Date(occurrence.occurredAt).toLocaleString()}</td>
                  {global && (
                    <td className="pr-4">
                      {occurrence.definition.name}
                      <span className="mt-1 block text-muted-foreground">
                        {occurrence.definition.context._tag === "Global"
                          ? "Global"
                          : root.projectCatalogStore.nameForPath(
                              occurrence.definition.context.projectPath,
                            )}
                      </span>
                    </td>
                  )}
                  <td className="pr-4">
                    {occurrence.source._tag === "Manual"
                      ? "Manual trigger"
                      : occurrence.source._tag === "Schedule"
                        ? `Schedule · ${new Date(occurrence.source.scheduledAt).toLocaleString()}`
                        : occurrence.source.event.replaceAll("-", " ")}
                    <span className="mt-1 block text-muted-foreground">
                      {occurrence.source._tag === "Event" ? (
                        occurrence.source.sourceMessageId ? (
                          <MarkdownLink
                            href={messageReference(
                              occurrence.source.sourceSessionId,
                              occurrence.source.sourceMessageId,
                            )}
                          >
                            Original message
                          </MarkdownLink>
                        ) : (
                          <SessionIdLink sessionId={occurrence.source.sourceSessionId} />
                        )
                      ) : occurrence.source._tag === "Manual" &&
                        occurrence.source.requestedBySessionId ? (
                        <SessionIdLink sessionId={occurrence.source.requestedBySessionId} />
                      ) : null}
                    </span>
                  </td>
                  <td className="pr-4">
                    {summary?.running
                      ? "running"
                      : (run?.status._tag ?? occurrence.disposition._tag)}
                    <span className="mt-1 block max-w-sm text-muted-foreground">
                      {"reason" in occurrence.disposition
                        ? occurrence.disposition.reason
                        : run && "reason" in run.status
                          ? run.status.reason
                          : null}
                    </span>
                  </td>
                  <td className="pr-4">
                    {run ? (resolved ? "Resolved" : "Unresolved") : "Not started"}
                  </td>
                  <td>
                    <div className="flex justify-end gap-2">
                      {run ? (
                        <>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() =>
                              root.navigationStore.openAutomationRun(
                                run,
                                occurrence.definition.name,
                              )
                            }
                          >
                            Open run
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={summary?.running || history.changing}
                            onClick={() =>
                              void root.automationSessionsStore
                                .loadRun(run, occurrence.definition.name)
                                .setResolved(!resolved)
                            }
                          >
                            {resolved ? "Unresolve" : "Resolve"}
                          </Button>
                          {summary?.running && (
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={history.changing}
                              onClick={() => void history.cancelRun(run.id)}
                            >
                              Stop
                            </Button>
                          )}
                        </>
                      ) : occurrence.disposition._tag === "queued" ? (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={history.changing}
                          onClick={() => void history.cancelQueued(occurrence.id)}
                        >
                          Cancel queued
                        </Button>
                      ) : null}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {!history.loading && history.loaded && history.occurrences.length === 0 && (
        <p className="py-8 text-sm text-muted-foreground">No runs yet.</p>
      )}
      {history.nextOffset !== null && (
        <Button
          className="mt-5"
          variant="outline"
          disabled={history.loading}
          onClick={() => void history.load(true)}
        >
          Load more occurrences
        </Button>
      )}
    </section>
  );
});
