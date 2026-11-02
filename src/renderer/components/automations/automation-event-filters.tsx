import { useState } from "react";
import { observer, useStore } from "r-state-tree/react";
import { RootStore } from "../../stores/RootStore";
import type { AutomationEventSessionKind } from "../../../contracts/automations/automation-data";
import { Chip } from "../ui/chip";
import { Select } from "../ui/select";
import { Input } from "../ui/input";
import { DisclosureTrigger } from "../ui/disclosure-trigger";

const sessionKinds: { value: AutomationEventSessionKind; label: string }[] = [
  { value: "cake-chat", label: "Cake Chat" },
  { value: "project-chat", label: "Project Chat" },
  { value: "standalone-project-session", label: "Standalone" },
  { value: "family-root", label: "Family root" },
  { value: "family-child", label: "Family child" },
];

export const AutomationEventFilters = observer(function AutomationEventFilters() {
  const root = useStore(RootStore);
  const editor = root.automationsStore.editor;
  const trigger = editor.definition?.trigger;
  const filter = trigger?._tag === "Event" ? trigger.filter : undefined;
  const hasFilters = Boolean(
    filter &&
    (filter.sessionId ||
      filter.contentContains ||
      filter.sessionKinds.length !== editor.eventSessionKinds.length),
  );
  const [expanded, setExpanded] = useState(false);
  if (!filter) return null;
  const sourceProject = filter.scope._tag === "Project" ? filter.scope.projectPath : undefined;
  const sessions = [
    ...root.cakeChatCatalogModel.sessions
      .filter(
        (session) =>
          session.projectPath === sourceProject &&
          filter.sessionKinds.includes(sourceProject ? "project-chat" : "cake-chat"),
      )
      .map((session) => ({
        sessionId: session.sessionId,
        title: sourceProject ? "Project Chat" : "Cake Chat",
      })),
    ...root.sessionCatalogStore.sessions
      .filter(
        (session) =>
          sourceProject &&
          session.projectPath === sourceProject &&
          !session.pending &&
          filter.sessionKinds.includes(
            session.familyParentSessionId
              ? "family-child"
              : session.familyId
                ? "family-root"
                : "standalone-project-session",
          ),
      )
      .map((session) => ({
        sessionId: session.sessionId,
        title: session.title || "Untitled session",
      })),
  ];
  return (
    <div>
      <DisclosureTrigger
        className="w-fit gap-2 text-muted-foreground"
        open={expanded}
        title="Filter events"
        subtitle={
          hasFilters
            ? [
                filter.sessionId
                  ? "One session"
                  : filter.sessionKinds.length !== editor.eventSessionKinds.length
                    ? sessionKinds
                        .filter((kind) => filter.sessionKinds.includes(kind.value))
                        .map((kind) => kind.label)
                        .join(", ")
                    : undefined,
                filter.contentContains ? "Message filter" : undefined,
              ]
                .filter(Boolean)
                .join(" · ")
            : undefined
        }
        chevronPosition="start"
        onClick={() => setExpanded(!expanded)}
      />
      {expanded && (
        <div className="mt-3 grid gap-3 border-l border-border/65 pl-4">
          {editor.eventSessionKinds.length > 1 && (
            <div className="grid gap-2 text-xs">
              <span className="text-muted-foreground">Session types</span>
              <div className="flex flex-wrap gap-2" aria-label="Source session kinds">
                {sessionKinds
                  .filter((kind) => editor.eventSessionKinds.includes(kind.value))
                  .map((kind) => (
                    <Chip
                      key={kind.value}
                      active={filter.sessionKinds.includes(kind.value)}
                      className="disabled:opacity-100"
                      disabled={
                        filter.sessionKinds.length === 1 && filter.sessionKinds.includes(kind.value)
                      }
                      onClick={() => {
                        const next = { ...filter };
                        delete next.sessionId;
                        next.sessionKinds = filter.sessionKinds.includes(kind.value)
                          ? filter.sessionKinds.filter((value) => value !== kind.value)
                          : [...filter.sessionKinds, kind.value];
                        editor.patch({ trigger: { _tag: "Event", filter: next } });
                      }}
                    >
                      {kind.label}
                    </Chip>
                  ))}
              </div>
            </div>
          )}
          <label className="grid grid-cols-[6rem_minmax(0,1fr)] items-center gap-3 text-xs">
            <span className="text-muted-foreground">From session</span>
            <Select
              aria-label="From session"
              value={filter.sessionId ?? ""}
              onChange={(event) => {
                const next = { ...filter };
                if (event.currentTarget.value) next.sessionId = event.currentTarget.value;
                else delete next.sessionId;
                editor.patch({ trigger: { _tag: "Event", filter: next } });
              }}
            >
              <option value="">Any matching session</option>
              {filter.sessionId &&
                !sessions.some((session) => session.sessionId === filter.sessionId) && (
                  <option value={filter.sessionId}>Selected session (unavailable)</option>
                )}
              {sessions.map((session) => (
                <option key={session.sessionId} value={session.sessionId}>
                  {session.title}
                </option>
              ))}
            </Select>
          </label>
          {filter.event !== "session-created" && (
            <label className="grid grid-cols-[6rem_minmax(0,1fr)] items-center gap-3 text-xs">
              <span className="text-muted-foreground">Message contains</span>
              <Input
                aria-label="Message contains"
                placeholder="Any message"
                value={filter.contentContains ?? ""}
                onChange={(event) => {
                  const next = { ...filter };
                  if (event.currentTarget.value) next.contentContains = event.currentTarget.value;
                  else delete next.contentContains;
                  editor.patch({ trigger: { _tag: "Event", filter: next } });
                }}
              />
            </label>
          )}
        </div>
      )}
    </div>
  );
});
