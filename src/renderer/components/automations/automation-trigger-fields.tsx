import { observer, useStore } from "r-state-tree/react";
import { RootStore } from "../../stores/RootStore";
import type {
  AutomationEventFilter,
  AutomationEventSessionKind,
} from "../../../contracts/automations/automation-data";
import { Chip } from "../ui/chip";
import { Select } from "../ui/select";
import { Input } from "../ui/input";
import { SegmentedControlGroup, SegmentedControlButton } from "../ui/segmented-control";
import { AutomationScheduleFields } from "./automation-schedule-fields";

const eventKinds = [
  { value: "user-message-received", label: "User message received" },
  { value: "assistant-response-completed", label: "Assistant response completed" },
  { value: "session-created", label: "Session created" },
] as const;
const sessionKinds: { value: AutomationEventSessionKind; label: string }[] = [
  { value: "cake-chat", label: "Cake Chat" },
  { value: "project-chat", label: "Project Chat" },
  { value: "standalone-project-session", label: "Standalone" },
  { value: "family-root", label: "Family root" },
  { value: "family-child", label: "Family child" },
];
export const AutomationTriggerFields = observer(function AutomationTriggerFields() {
  const root = useStore(RootStore);
  const editor = root.automationsStore.editor;
  const definition = editor.definition;
  if (!definition) return null;
  const trigger = definition.trigger;
  const filter = trigger._tag === "Event" ? trigger.filter : undefined;
  const updateFilter = (patch: Partial<AutomationEventFilter>) => {
    if (filter) editor.patch({ trigger: { _tag: "Event", filter: { ...filter, ...patch } } });
  };
  return (
    <section className="rounded-lg border border-border/75" aria-label="Trigger">
      <h2 className="border-b border-border/65 px-4 py-3 text-xs font-semibold">Trigger</h2>
      <div className="grid gap-4 p-4">
        <SegmentedControlGroup aria-label="Trigger kind" className="w-fit">
          <SegmentedControlButton
            active={trigger._tag === "Event"}
            onClick={() => {
              if (trigger._tag !== "Event")
                editor.patch({
                  trigger: {
                    _tag: "Event",
                    filter: {
                      event: "assistant-response-completed",
                      scope: { _tag: "Any" },
                      sessionKinds: ["standalone-project-session"],
                    },
                  },
                });
            }}
          >
            Event
          </SegmentedControlButton>
          <SegmentedControlButton
            active={trigger._tag === "Schedule"}
            onClick={() => {
              if (trigger._tag !== "Schedule")
                editor.patch({
                  trigger: {
                    _tag: "Schedule",
                    schedule: {
                      _tag: "Interval",
                      everySeconds: 86400,
                      startsAt: new Date(Date.now() + 3600000).toISOString(),
                    },
                  },
                });
            }}
          >
            Schedule
          </SegmentedControlButton>
        </SegmentedControlGroup>
        {filter ? (
          <>
            <label className="grid grid-cols-[6rem_minmax(0,1fr)] items-center gap-3 text-xs">
              <span className="text-muted-foreground">Event</span>
              <Select
                aria-label="Automation event"
                value={filter.event}
                onChange={(event) => {
                  const kind = eventKinds.find((kind) => kind.value === event.currentTarget.value);
                  if (kind) updateFilter({ event: kind.value });
                }}
              >
                {eventKinds.map((kind) => (
                  <option key={kind.value} value={kind.value}>
                    {kind.label}
                  </option>
                ))}
              </Select>
            </label>
            <label className="grid grid-cols-[6rem_minmax(0,1fr)] items-center gap-3 text-xs">
              <span className="text-muted-foreground">Source</span>
              <Select
                aria-label="Event source scope"
                value={
                  filter.scope._tag === "Project" ? filter.scope.projectPath : filter.scope._tag
                }
                onChange={(event) =>
                  updateFilter({
                    scope:
                      event.currentTarget.value === "Any"
                        ? { _tag: "Any" }
                        : event.currentTarget.value === "Global"
                          ? { _tag: "Global" }
                          : { _tag: "Project", projectPath: event.currentTarget.value },
                  })
                }
              >
                <option value="Any">All contexts</option>
                <option value="Global">Global</option>
                {root.projectCatalogStore.projects.map((project) => (
                  <option key={project.path} value={project.path}>
                    {project.name}
                  </option>
                ))}
              </Select>
            </label>
            <div
              className="flex flex-wrap gap-2 border-t border-border/65 pt-4"
              aria-label="Source session kinds"
            >
              {sessionKinds.map((kind) => (
                <Chip
                  key={kind.value}
                  active={filter.sessionKinds.includes(kind.value)}
                  className="disabled:opacity-100"
                  disabled={
                    filter.sessionKinds.length === 1 && filter.sessionKinds.includes(kind.value)
                  }
                  onClick={() =>
                    updateFilter({
                      sessionKinds: filter.sessionKinds.includes(kind.value)
                        ? filter.sessionKinds.filter((value) => value !== kind.value)
                        : [...filter.sessionKinds, kind.value],
                    })
                  }
                >
                  {kind.label}
                </Chip>
              ))}
            </div>
            <label className="grid grid-cols-[6rem_minmax(0,1fr)] items-center gap-3 text-xs">
              <span className="text-muted-foreground">Session</span>
              <Input
                aria-label="Exact source session"
                placeholder="Any matching session"
                value={filter.sessionId ?? ""}
                onChange={(event) => {
                  const next = { ...filter };
                  if (event.currentTarget.value) next.sessionId = event.currentTarget.value;
                  else delete next.sessionId;
                  editor.patch({ trigger: { _tag: "Event", filter: next } });
                }}
              />
            </label>
            <label className="grid grid-cols-[6rem_minmax(0,1fr)] items-center gap-3 text-xs">
              <span className="text-muted-foreground">Content</span>
              <Input
                aria-label="Event content contains"
                placeholder="Any content"
                value={filter.contentContains ?? ""}
                onChange={(event) => {
                  const next = { ...filter };
                  if (event.currentTarget.value) next.contentContains = event.currentTarget.value;
                  else delete next.contentContains;
                  editor.patch({ trigger: { _tag: "Event", filter: next } });
                }}
              />
            </label>
          </>
        ) : (
          <AutomationScheduleFields />
        )}
      </div>
    </section>
  );
});
