import { observer, useStore } from "r-state-tree/react";
import { RootStore } from "../../stores/RootStore";
import { Select } from "../ui/select";
import { SegmentedControlGroup, SegmentedControlButton } from "../ui/segmented-control";
import { AutomationScheduleFields } from "./automation-schedule-fields";
import { AutomationEventFilters } from "./automation-event-filters";

const eventKinds = [
  { value: "user-message-received", label: "User message received" },
  { value: "assistant-response-completed", label: "Assistant response completed" },
  { value: "session-created", label: "Session created" },
] as const;

export const AutomationTriggerFields = observer(function AutomationTriggerFields() {
  const editor = useStore(RootStore).automationsStore.editor;
  const definition = editor.definition;
  if (!definition) return null;
  const trigger = definition.trigger;
  const filter = trigger._tag === "Event" ? trigger.filter : undefined;
  return (
    <section className="grid gap-3 border-t border-border/65 pt-4" aria-label="Trigger">
      <div className="flex items-center gap-3 text-xs">
        <h2 className="w-24 shrink-0 font-medium">Trigger</h2>
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
                      scope: definition.context,
                      sessionKinds: editor.eventSessionKinds,
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
      </div>
      {filter ? (
        <>
          <label className="grid grid-cols-[6rem_minmax(0,1fr)] items-center gap-3 text-xs">
            <span className="text-muted-foreground">When</span>
            <Select
              aria-label="Automation event"
              value={filter.event}
              onChange={(event) => {
                const kind = eventKinds.find((kind) => kind.value === event.currentTarget.value);
                if (kind) {
                  const next = { ...filter, event: kind.value };
                  if (kind.value === "session-created") delete next.contentContains;
                  editor.patch({ trigger: { _tag: "Event", filter: next } });
                }
              }}
            >
              {eventKinds.map((kind) => (
                <option key={kind.value} value={kind.value}>
                  {kind.label}
                </option>
              ))}
            </Select>
          </label>
          <AutomationEventFilters />
        </>
      ) : (
        <AutomationScheduleFields />
      )}
    </section>
  );
});
