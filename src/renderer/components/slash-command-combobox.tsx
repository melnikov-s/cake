import { useEffect, useId, useMemo, useRef, useState, type ComponentProps, type KeyboardEvent } from "react";
import type { SessionSnapshot } from "../../ipc/session-contract";
import { ComposerInput } from "./ai-elements/composer";

type SlashCommand = SessionSnapshot["commands"][number];

interface SlashCommandComboboxProps extends Omit<ComponentProps<typeof ComposerInput>, "onChange" | "onKeyDown" | "value"> {
  commands: SlashCommand[];
  value: string;
  onValueChange(value: string): void;
  onSubmit(): void;
}

export function SlashCommandCombobox({ commands, value, onValueChange, onSubmit, ...inputProps }: SlashCommandComboboxProps) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const listboxId = useId();
  const [activeIndex, setActiveIndex] = useState(0);
  const [dismissedValue, setDismissedValue] = useState<string>();
  const draft = value.trim();
  const commandPrefix = draft.slice(1).toLocaleLowerCase();
  const filteredCommands = useMemo(() => commands.filter((command) => command.name.toLocaleLowerCase().startsWith(commandPrefix)), [commands, commandPrefix]);
  const eligible = draft.startsWith("/") && !draft.includes(" ") && filteredCommands.length > 0;
  const open = eligible && dismissedValue !== value;
  const selectedIndex = Math.min(activeIndex, Math.max(0, filteredCommands.length - 1));

  useEffect(() => {
    setActiveIndex(0);
  }, [commandPrefix]);

  useEffect(() => {
    if (!open) return;
    document.getElementById(`${listboxId}-option-${selectedIndex}`)?.scrollIntoView?.({ block: "nearest" });
  }, [listboxId, open, selectedIndex]);

  const choose = (command: SlashCommand) => {
    onValueChange(`/${command.name} `);
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (open && event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((index) => (index + 1) % filteredCommands.length);
    } else if (open && event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((index) => (index - 1 + filteredCommands.length) % filteredCommands.length);
    } else if (open && event.key === "Enter" && !event.nativeEvent.isComposing) {
      event.preventDefault();
      choose(filteredCommands[selectedIndex]!);
    } else if (open && event.key === "Escape") {
      event.preventDefault();
      setDismissedValue(value);
    } else if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      onSubmit();
    }
  };

  return <>
    {open && <div className="slash-command-menu" id={listboxId} role="listbox" aria-label="Slash commands">
      {filteredCommands.map((command, index) => <button
        id={`${listboxId}-option-${index}`}
        key={`${command.source}:${command.name}`}
        className={index === selectedIndex ? "active" : undefined}
        type="button"
        role="option"
        aria-selected={index === selectedIndex}
        onMouseEnter={() => setActiveIndex(index)}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => choose(command)}
      ><code>/{command.name}</code><span><strong>{command.description ?? command.name}</strong><small>{command.source} · {command.sourceInfo.scope}</small></span></button>)}
    </div>}
    <ComposerInput
      {...inputProps}
      ref={inputRef}
      role="combobox"
      aria-autocomplete="list"
      aria-expanded={open}
      aria-controls={open ? listboxId : undefined}
      aria-activedescendant={open ? `${listboxId}-option-${selectedIndex}` : undefined}
      value={value}
      onChange={(event) => { setDismissedValue(undefined); onValueChange(event.target.value); }}
      onKeyDown={onKeyDown}
    />
  </>;
}
