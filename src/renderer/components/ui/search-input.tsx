import { useRef } from "react";
import { CloseIcon, SearchIcon } from "./icons";
import { IconButton } from "./icon-button";
import { Input, type InputProps } from "./input";
import { cn } from "@/lib/utils";

/** Callers may add combobox semantics and key handling; Escape clears a non-empty query first. */
export function SearchInput({
  label,
  value,
  onValueChange,
  className,
  onKeyDown,
  placeholder = "Search…",
  ...inputProps
}: Omit<InputProps, "value" | "onChange" | "type" | "size" | "variant"> & {
  label: string;
  value: string;
  onValueChange(value: string): void;
  className?: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const clear = () => {
    onValueChange("");
    ref.current?.focus();
  };
  return (
    <div className={cn("relative min-w-0", className)}>
      <SearchIcon
        size={18}
        className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground"
      />
      <Input
        {...inputProps}
        ref={ref}
        type="search"
        aria-label={label}
        placeholder={placeholder}
        value={value}
        onChange={(event) => onValueChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape" && value) {
            event.preventDefault();
            event.stopPropagation();
            clear();
            return;
          }
          onKeyDown?.(event);
        }}
        className="h-7 rounded-md pl-7 pr-7 text-xs [&::-webkit-search-cancel-button]:appearance-none"
      />
      {value && (
        <IconButton
          iconSize="inline"
          tooltip={`Clear ${label.toLowerCase()}`}
          onClick={clear}
          className="absolute right-0.5 top-1/2 size-6 -translate-y-1/2"
        >
          <CloseIcon size={12} />
        </IconButton>
      )}
    </div>
  );
}
