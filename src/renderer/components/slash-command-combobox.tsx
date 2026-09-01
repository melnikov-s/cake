import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type KeyboardEvent,
} from "react";
import { flushSync } from "react-dom";
import type { FileSuggestion, SessionSnapshot } from "../../ipc/session-contract";
import { ComposerInput } from "./ai-elements/composer";
import { NavItem } from "./ui/nav-item";

type SlashCommand = SessionSnapshot["commands"][number];

interface SlashCommandComboboxProps extends Omit<
  ComponentProps<typeof ComposerInput>,
  "onChange" | "onInput" | "onKeyDown" | "onSubmit" | "value"
> {
  commands: ReadonlyArray<SlashCommand>;
  focusRequestRevision?: number;
  value: string;
  suggestFiles?(prefix: string): Promise<ReadonlyArray<FileSuggestion>>;
  onValueChange(value: string): void;
  onSubmit(value?: string): void | Promise<void>;
  onEscape?(): void;
  inputRef?(input: HTMLTextAreaElement | null): void;
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
  if (
    inQuotes &&
    quoteStart > 0 &&
    line[quoteStart - 1] === "@" &&
    isTokenStart(line, quoteStart - 1)
  ) {
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

export function SlashCommandCombobox({
  commands,
  focusRequestRevision,
  value,
  suggestFiles,
  onValueChange,
  onSubmit,
  onEscape,
  inputRef: forwardedInputRef,
  ...inputProps
}: SlashCommandComboboxProps) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const suggestFilesRef = useRef(suggestFiles);
  const requestRevision = useRef(0);
  const pendingCursor = useRef<number | undefined>(undefined);
  const listboxId = useId();
  const [inputValue, setInputValue] = useState(value);
  const [cursor, setCursor] = useState(value.length);
  const [activeIndex, setActiveIndex] = useState(0);
  const [dismissedValue, setDismissedValue] = useState<string>();
  const [dismissedMention, setDismissedMention] = useState<string>();
  const [fileResults, setFileResults] = useState<{ key: string; items: FileSuggestion[] }>({
    key: "",
    items: [],
  });
  const draft = inputValue.trimStart();
  const commandPrefix = draft.slice(1).toLocaleLowerCase();
  const filteredCommands = useMemo(
    () => commands.filter((command) => command.name.toLocaleLowerCase().startsWith(commandPrefix)),
    [commands, commandPrefix],
  );
  const commandEligible = draft.startsWith("/") && !/\s/.test(draft) && filteredCommands.length > 0;
  const commandOpen = commandEligible && dismissedValue !== inputValue;
  const fileMention = useMemo(() => findFileMention(inputValue, cursor), [cursor, inputValue]);
  const fileOpen = Boolean(
    fileMention && fileResults.items.length > 0 && dismissedMention !== fileMention.key,
  );
  const menuKind = fileOpen ? "files" : commandOpen ? "commands" : undefined;
  const menuItems = menuKind === "files" ? fileResults.items : filteredCommands;
  const open = Boolean(menuKind);
  const selectedIndex = Math.min(activeIndex, Math.max(0, menuItems.length - 1));

  useEffect(() => {
    suggestFilesRef.current = suggestFiles;
  }, [suggestFiles]);

  useEffect(() => {
    setInputValue(value);
  }, [value]);

  useEffect(() => {
    if (!focusRequestRevision) return;
    const frame = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [focusRequestRevision]);

  useLayoutEffect(() => {
    if (pendingCursor.current === undefined) return;
    inputRef.current?.setSelectionRange(pendingCursor.current, pendingCursor.current);
    pendingCursor.current = undefined;
  }, [inputValue]);

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
          if (revision === requestRevision.current)
            setFileResults({ key: fileMention.key, items: [...items] });
        })
        .catch(() => {
          if (revision === requestRevision.current)
            setFileResults({ key: fileMention.key, items: [] });
        });
    }, 20);
    return () => window.clearTimeout(timer);
  }, [dismissedMention, fileMention?.key, fileMention?.prefix]);

  useEffect(() => {
    if (!open) return;
    document
      .getElementById(`${listboxId}-option-${selectedIndex}`)
      ?.scrollIntoView?.({ block: "nearest" });
  }, [listboxId, open, selectedIndex]);

  const commitValue = (nextValue: string) => {
    setInputValue(nextValue);
    onValueChange(nextValue);
  };

  const chooseCommand = (command: SlashCommand) => {
    commitValue(`/${command.name} `);
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  const restoreFocusAfterSubmit = async (submittedValue?: string) => {
    try {
      await onSubmit(submittedValue);
    } finally {
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  };

  const executeCommand = (command: SlashCommand) => {
    const commandValue = `/${command.name}`;
    commitValue(commandValue);
    void onSubmit(commandValue);
  };

  const chooseFile = (item: FileSuggestion) => {
    if (!fileMention) return;
    const isDirectory = item.label.endsWith("/");
    const suffix = isDirectory ? "" : " ";
    let afterCursor = inputValue.slice(fileMention.end);
    if (
      fileMention.token.startsWith('@"') &&
      item.value.endsWith('"') &&
      afterCursor.startsWith('"')
    )
      afterCursor = afterCursor.slice(1);
    const nextValue = `${inputValue.slice(0, fileMention.start)}${item.value}${suffix}${afterCursor}`;
    const trailingQuoteOffset = isDirectory && item.value.endsWith('"') ? 1 : 0;
    const nextCursor = fileMention.start + item.value.length + suffix.length - trailingQuoteOffset;
    pendingCursor.current = nextCursor;
    setCursor(nextCursor);
    setActiveIndex(0);
    setDismissedMention(undefined);
    commitValue(nextValue);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
    });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (open && event.key === "ArrowDown") {
      event.preventDefault();
      flushSync(() => setActiveIndex((index) => (index + 1) % menuItems.length));
    } else if (open && event.key === "ArrowUp") {
      event.preventDefault();
      flushSync(() => setActiveIndex((index) => (index - 1 + menuItems.length) % menuItems.length));
    } else if (
      menuKind === "files" &&
      (event.key === "Enter" || event.key === "Tab") &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault();
      chooseFile(fileResults.items[selectedIndex]!);
    } else if (menuKind === "commands" && event.key === "Enter" && !event.nativeEvent.isComposing) {
      event.preventDefault();
      executeCommand(filteredCommands[selectedIndex]!);
    } else if (
      menuKind === "commands" &&
      (event.key === "Tab" || event.key === "ArrowLeft" || event.key === "ArrowRight")
    ) {
      event.preventDefault();
      chooseCommand(filteredCommands[selectedIndex]!);
    } else if (open && event.key === "Escape") {
      event.preventDefault();
      if (menuKind === "files") setDismissedMention(fileMention?.key);
      else setDismissedValue(inputValue);
    } else if (event.key === "Escape" && onEscape) {
      event.preventDefault();
      event.stopPropagation();
      onEscape();
    } else if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void restoreFocusAfterSubmit(inputValue);
    }
  };

  return (
    <>
      {open && (
        <div
          className="absolute bottom-[calc(100%+8px)] inset-x-0 z-50 flex max-h-72 flex-col gap-0.5 overflow-y-auto rounded-xl border border-border bg-popover p-1.5 text-popover-foreground shadow-2xl"
          id={listboxId}
          role="listbox"
          aria-label={menuKind === "files" ? "Project files" : "Slash commands"}
        >
          {menuKind === "files"
            ? fileResults.items.map((item, index) => (
                <NavItem
                  id={`${listboxId}-option-${index}`}
                  key={`${item.value}:${index}`}
                  active={index === selectedIndex}
                  role="option"
                  aria-selected={index === selectedIndex}
                  onMouseEnter={() => setActiveIndex(index)}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => chooseFile(item)}
                  icon={
                    <code className="font-mono text-[11px] font-semibold text-accent whitespace-nowrap">
                      {item.label}
                    </code>
                  }
                  label={item.description ?? item.value.replace(/^@/, "")}
                  description={item.label.endsWith("/") ? "Folder" : "File"}
                />
              ))
            : filteredCommands.map((command, index) => (
                <NavItem
                  id={`${listboxId}-option-${index}`}
                  key={`${command.source}:${command.name}`}
                  active={index === selectedIndex}
                  role="option"
                  aria-selected={index === selectedIndex}
                  onMouseEnter={() => setActiveIndex(index)}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => chooseCommand(command)}
                  icon={
                    <code className="font-mono text-[11px] font-semibold text-accent whitespace-nowrap">
                      /{command.name}
                      {command.argumentHint ? ` ${command.argumentHint}` : ""}
                    </code>
                  }
                  label={command.description ?? command.name}
                  description={
                    command.source === "builtin"
                      ? "Pi CLI"
                      : `${command.source} · ${command.sourceInfo.scope}`
                  }
                />
              ))}
        </div>
      )}
      <ComposerInput
        {...inputProps}
        ref={(node) => {
          inputRef.current = node;
          forwardedInputRef?.(node);
        }}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-activedescendant={open ? `${listboxId}-option-${selectedIndex}` : undefined}
        spellCheck={!draft.startsWith("/")}
        value={inputValue}
        onChange={(event) => {
          const nextValue = event.currentTarget.value;
          commitValue(nextValue);
          setActiveIndex(0);
          setDismissedValue(undefined);
          setDismissedMention(undefined);
          setCursor(event.currentTarget.selectionStart ?? nextValue.length);
        }}
        onSelect={(event) => {
          setCursor(event.currentTarget.selectionStart ?? event.currentTarget.value.length);
        }}
        onKeyDown={onKeyDown}
      />
    </>
  );
}
