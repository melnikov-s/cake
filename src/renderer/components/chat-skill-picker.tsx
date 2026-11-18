import { useState } from "react";
import { observer } from "r-state-tree/react";
import type { ChatStore } from "../stores/ChatStore";
import type { StagedSessionCommandStore } from "../stores/StagedSessionCommandStore";
import { Button } from "./ui/button";
import { SkillIcon } from "./ui/icons";
import { LoadingState } from "./ui/loading-state";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { SearchableChoiceList } from "./ui/searchable-choice-list";

export const ChatSkillPicker = observer(function ChatSkillPicker({
  store,
  commands,
}: {
  store: ChatStore;
  commands: StagedSessionCommandStore;
}) {
  const [open, setOpen] = useState(false);
  const skills = open
    ? commands.resourceCommands.filter((command) => command.source === "skill")
    : [];
  const selected = open ? /^\s*\/(skill:[^\s]+)(?:\s+|$)/.exec(store.draft) : undefined;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger variant="ghost" size="sm" disabled={store.submitting}>
        <SkillIcon />
        Skills
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        aria-label="Choose a skill"
        initialFocusSelector='[role="combobox"]'
        className="flex w-80 max-w-[calc(100vw-2rem)] flex-col overflow-hidden p-0"
      >
        {commands.loading ? (
          <div className="p-3">
            <LoadingState label="Loading skills" />
          </div>
        ) : commands.error ? (
          <div className="grid justify-items-start gap-2 p-3">
            <p role="status" className="m-0 break-words text-xs text-muted-foreground">
              Could not load skills: {commands.error}
            </p>
            <Button size="sm" variant="outline" onClick={() => void commands.retry()}>
              Retry
            </Button>
          </div>
        ) : (
          <SearchableChoiceList
            searchLabel="Filter skills"
            choicesLabel="Skills"
            emptyMessage="No matching skills"
            choices={(query) => {
              const needle = query.trim().toLocaleLowerCase();
              return skills.flatMap((skill) => {
                const label = skill.name.slice("skill:".length);
                const description = [skill.description, skill.sourceInfo.scope]
                  .filter(Boolean)
                  .join(" · ");
                return `${label} ${description}`.toLocaleLowerCase().includes(needle)
                  ? [{ id: skill.name, label, description }]
                  : [];
              });
            }}
            selectedId={selected?.[1]}
            onSelect={(name) => {
              if (
                !commands.resourceCommands.some(
                  (skill) => skill.source === "skill" && skill.name === name,
                )
              )
                return;
              store.setDraft(`/${name} ${store.draft.slice(selected?.[0].length ?? 0)}`);
              setOpen(false);
              store.requestDraftFocus();
            }}
          />
        )}
      </PopoverContent>
    </Popover>
  );
});
