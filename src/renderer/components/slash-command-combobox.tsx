import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ComponentProps, type KeyboardEvent } from "react";
import type { FileSuggestion, SessionSnapshot } from "../../ipc/session-contract";
import { ComposerInput } from "./ai-elements/composer";

type SlashCommand = SessionSnapshot["commands"][number];

interface SlashCommandComboboxProps extends Omit<ComponentProps<typeof ComposerInput>, "onChange" | "onKeyDown" | "onSubmit" | "value"> {
  commands: SlashCommand[];
  value: string;
  suggestFiles?(prefix: string): Promise<FileSuggestion[]>;
  onValueChange(value: string): void;
  onSubmit(value?: string): void;
}

interface FileMention {
  start: number;
  end: number;
  token: string;
  prefix: string;
  key: string;
}

const pathDelimiters = new Set([" ", "\t", "\n", "'", "=", "\r"]);

function isTokenStart(text: string, index: number) {
  return index === 0 || pathDelimiters.has(text[index - 1] ?? "");
}

export function findFileMention(text: string, cursor: number): FileMention | undefined {
  const beforeCursor = text.slice(0, cursor);
  const lineStart = Math.max(beforeCursor.lastIndexOf("\n"), beforeCursor.lastIndexOf("\r")) + 1;
  const line = beforeCursor.slice(lineStart);
  let inQuotes = false;
  let quoteStart = -1;
  for (let index = 0; index < line.length; index += 1) {
    if (line[index] === '"') {
      inQuotes = !inQuotes;
      if (inQuotes) quoteStart = index;
    }
  }
  if (inQuotes && quoteStart > 0 && line[quoteStart - 1] === "@" && isTokenStart(line, quoteStart - 1)) {
    const start = lineStart + quoteStart - 1;
    const token = text.slice(start, cursor);
    return { start, end: cursor, token, prefix: token.slice(1), key: `${start}:${token}` };
  }

  let delimiter = -1;
  for (let index = line.length - 1; index >= 0; index -= 1) {
    if (pathDelimiters.has(line[index] ?? "") || line[index] === '"') {
      delimiter = index;
      break;
    }
  }
  const tokenStart = delimiter + 1;
  if (line[tokenStart] !== "@") return undefined;
  const start = lineStart + tokenStart;
  const token = text.slice(start, cursor);
  return { start, end: cursor, token, prefix: token.slice(1), key: `${start}:${token}` };
}

export function SlashCommandCombobox({ commands, value, suggestFiles, onValueChange, onSubmit, ...inputProps }: SlashCommandComboboxProps) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const suggestFilesRef = useRef(suggestFiles);
  const requestRevision = useRef(0);
  const pendingCursor = useRef<number | undefined>(undefined);
  const listboxId = useId();
  const [cursor, setCursor] = useState(value.length);
  const [activeIndex, setActiveIndex] = useState(0);
  const [dismissedValue, setDismissedValue] = useState<string>();
  const [dismissedMention, setDismissedMention] = useState<string>();
  const [fileResults, setFileResults] = useState<{ key: string; items: FileSuggestion[] }>({ key: "", items: [] });
  const draft = value.trimStart();
  const commandPrefix = draft.slice(1).toLocaleLowerCase();
  const filteredCommands = useMemo(() => commands.filter((command) => command.name.toLocaleLowerCase().startsWith(commandPrefix)), [commands, commandPrefix]);
  const commandEligible = draft.startsWith("/") && !/\s/.test(draft) && filteredCommands.length > 0;
  const commandOpen = commandEligible && dismissedValue !== value;
  const fileMention = useMemo(() => findFileMention(value, cursor), [cursor, value]);
  const fileOpen = Boolean(fileMention && fileResults.items.length > 0 && dismissedMention !== fileMention.key);
  const menuKind = fileOpen ? "files" : commandOpen ? "commands" : undefined;
  const menuItems = menuKind === "files" ? fileResults.items : filteredCommands;
  const open = Boolean(menuKind);
  const selectedIndex = Math.min(activeIndex, Math.max(0, menuItems.length - 1));

  useEffect(() => {
    suggestFilesRef.current = suggestFiles;
  }, [suggestFiles]);

  useLayoutEffect(() => {
    if (pendingCursor.current === undefined) return;
    inputRef.current?.setSelectionRange(pendingCursor.current, pendingCursor.current);
    pendingCursor.current = undefined;
  }, [value]);

  useEffect(() => {
    const revision = ++requestRevision.current;
    if (!fileMention || !suggestFilesRef.current) {
      setFileResults({ key: "", items: [] });
      return;
    }
    if (dismissedMention === fileMention.key) return;
    const timer = window.setTimeout(() => {
      void suggestFilesRef.current!(fileMention.prefix)
        .then((items) => {
          if (revision === requestRevision.current) setFileResults({ key: fileMention.key, items });
        })
        .catch(() => {
          if (revision === requestRevision.current) setFileResults({ key: fileMention.key, items: [] });
        });
    }, 20);
    return () => window.clearTimeout(timer);
  }, [dismissedMention, fileMention?.key, fileMention?.prefix]);

  useEffect(() => {
    if (!open) return;
    document.getElementById(`${listboxId}-option-${selectedIndex}`)?.scrollIntoView?.({ block: "nearest" });
  }, [listboxId, open, selectedIndex]);

  const chooseCommand = (command: SlashCommand) => {
    onValueChange(`/${command.name} `);
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  const executeCommand = (command: SlashCommand) => {
    const commandValue = `/${command.name}`;
    onValueChange(commandValue);
    onSubmit(commandValue);
  };

  const chooseFile = (item: FileSuggestion) => {
    if (!fileMention) return;
    const isDirectory = item.label.endsWith("/");
    const suffix = isDirectory ? "" : " ";
    let afterCursor = value.slice(fileMention.end);
    if (fileMention.token.startsWith('@"') && item.value.endsWith('"') && afterCursor.startsWith('"')) afterCursor = afterCursor.slice(1);
    const nextValue = `${value.slice(0, fileMention.start)}${item.value}${suffix}${afterCursor}`;
    const trailingQuoteOffset = isDirectory && item.value.endsWith('"') ? 1 : 0;
    const nextCursor = fileMention.start + item.value.length + suffix.length - trailingQuoteOffset;
    pendingCursor.current = nextCursor;
    setCursor(nextCursor);
    setActiveIndex(0);
    setDismissedMention(undefined);
    onValueChange(nextValue);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
    });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (open && event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((index) => (index + 1) % menuItems.length);
    } else if (open && event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((index) => (index - 1 + menuItems.length) % menuItems.length);
    } else if (menuKind === "files" && (event.key === "Enter" || event.key === "Tab") && !event.nativeEvent.isComposing) {
      event.preventDefault();
      chooseFile(fileResults.items[selectedIndex]!);
    } else if (menuKind === "commands" && event.key === "Enter" && !event.nativeEvent.isComposing) {
      event.preventDefault();
      executeCommand(filteredCommands[selectedIndex]!);
    } else if (menuKind === "commands" && (event.key === "Tab" || event.key === "ArrowLeft" || event.key === "ArrowRight")) {
      event.preventDefault();
      chooseCommand(filteredCommands[selectedIndex]!);
    } else if (open && event.key === "Escape") {
      event.preventDefault();
      if (menuKind === "files") setDismissedMention(fileMention?.key);
      else setDismissedValue(value);
    } else if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      onSubmit(value);
    }
  };

  return <>
    {open && <div className={`slash-command-menu ${menuKind === "files" ? "file-mention-menu" : ""}`} id={listboxId} role="listbox" aria-label={menuKind === "files" ? "Project files" : "Slash commands"}>
      {menuKind === "files" ? fileResults.items.map((item, index) => <button
        id={`${listboxId}-option-${index}`}
        key={`${item.value}:${index}`}
        className={index === selectedIndex ? "active" : undefined}
        type="button"
        role="option"
        aria-selected={index === selectedIndex}
        onMouseEnter={() => setActiveIndex(index)}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => chooseFile(item)}
      ><code>{item.label}</code><span><strong>{item.description ?? item.value.replace(/^@/, "")}</strong><small>{item.label.endsWith("/") ? "Folder" : "File"}</small></span></button>) : filteredCommands.map((command, index) => <button
        id={`${listboxId}-option-${index}`}
        key={`${command.source}:${command.name}`}
        className={index === selectedIndex ? "active" : undefined}
        type="button"
        role="option"
        aria-selected={index === selectedIndex}
        onMouseEnter={() => setActiveIndex(index)}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => chooseCommand(command)}
      ><code>/{command.name}{command.argumentHint ? ` ${command.argumentHint}` : ""}</code><span><strong>{command.description ?? command.name}</strong><small>{command.source === "builtin" ? "Pi CLI" : `${command.source} · ${command.sourceInfo.scope}`}</small></span></button>)}
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
      onChange={(event) => {
        setActiveIndex(0);
        setDismissedValue(undefined);
        setDismissedMention(undefined);
        setCursor(event.target.selectionStart ?? event.target.value.length);
        onValueChange(event.target.value);
      }}
      onSelect={(event) => {
        setActiveIndex(0);
        setCursor(event.currentTarget.selectionStart ?? event.currentTarget.value.length);
      }}
      onKeyDown={onKeyDown}
    />
  </>;
}
