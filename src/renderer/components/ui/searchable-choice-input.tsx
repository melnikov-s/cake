import { useEffect, useRef, useState, useTransition, type ComponentProps, type Ref } from "react";
import { Input } from "./input";
import { SearchIcon } from "./icons";

/** Draft text is urgent and local; filtering/list updates are lower-priority React work.
 * Never transition a reactive Store write here: external-store updates are synchronous. */
export function SearchableChoiceInput({
  inputRef,
  query,
  onQueryChange,
  onConfirm,
  onKeyDown,
  ...props
}: Omit<ComponentProps<typeof Input>, "value" | "onChange" | "ref"> & {
  inputRef: Ref<HTMLInputElement>;
  query: string;
  onQueryChange(query: string): void;
  onConfirm(): void;
}) {
  const [draft, setDraft] = useState(query);
  const [pending, startTransition] = useTransition();
  const stale = pending || draft !== query;
  const queuedConfirm = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!stale && queuedConfirm.current === draft) {
      queuedConfirm.current = undefined;
      onConfirm();
    }
  }, [stale, draft, onConfirm]);
  return (
    <div className="relative">
      <SearchIcon className="pointer-events-none absolute left-3 top-3 text-muted-foreground" />
      <Input
        {...props}
        ref={inputRef}
        className="pl-9"
        value={draft}
        aria-busy={stale}
        onChange={(event) => {
          const value = event.target.value;
          queuedConfirm.current = undefined;
          setDraft(value);
          startTransition(() => onQueryChange(value));
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          // Enter waits for the latest draft rather than opening an old match or
          // requiring the user to press Enter again after a fast typing burst.
          if (event.key === "Enter") {
            event.preventDefault();
            if (stale) queuedConfirm.current = draft;
            else onConfirm();
            return;
          }
          if (stale && ["ArrowDown", "ArrowUp"].includes(event.key)) {
            event.preventDefault();
            return;
          }
          onKeyDown?.(event);
        }}
      />
    </div>
  );
}
