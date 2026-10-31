import type { EditorColorTheme } from "../../../contracts/themes/color-theme";
import { cn } from "../../lib/utils";
import { Button } from "./button";
import { CheckIcon } from "./icons";
import { ThemePreviewScene } from "./theme-preview-scene";

export function ThemePreviewCard({
  name,
  theme,
  selected,
  onSelect,
}: {
  name: string;
  theme: EditorColorTheme;
  selected: boolean;
  onSelect(): void;
}) {
  return (
    <Button
      aria-label={`${name} theme`}
      aria-pressed={selected}
      variant="ghost"
      className={cn(
        "grid h-auto w-full min-w-0 grid-rows-[auto_auto] items-stretch justify-stretch gap-0 overflow-hidden rounded-lg border bg-card p-0 text-left whitespace-normal shadow-2xs hover:bg-card focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
        selected ? "border-accent ring-2 ring-accent/40" : "border-border hover:border-accent/50",
      )}
      onClick={onSelect}
    >
      <ThemePreviewScene theme={theme} />
      <span className="flex w-full min-w-0 items-center justify-between gap-2 border-t border-border bg-card px-2.5 py-2 text-xs font-medium text-foreground">
        <span className="truncate">{name}</span>
        <span aria-hidden="true" className={cn("shrink-0 text-accent", !selected && "invisible")}>
          <CheckIcon />
        </span>
      </span>
    </Button>
  );
}
