import { Button } from "./button";

/** Compact labelled actions; navigation is a configuration, not an implicit workflow. */
export function ActionBar({
  label,
  progress,
  actions,
  busy = false,
  onAction,
}: {
  readonly label: string;
  readonly progress?: { readonly current: number; readonly total: number };
  readonly actions: readonly {
    readonly id: string;
    readonly label: string;
    readonly primary?: boolean;
    readonly disabled?: boolean;
    readonly message?: string;
  }[];
  readonly busy?: boolean;
  readonly onAction: (id: string) => void;
}) {
  return (
    <div
      className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-card p-3 text-card-foreground"
      role="group"
      aria-label={label}
      aria-busy={busy}
    >
      <div className="min-w-0 flex-1 text-sm">
        <span className="break-words font-medium">{label}</span>
        {progress && (
          <span className="ml-2 whitespace-nowrap text-xs text-muted-foreground">
            {progress.current} / {progress.total}
          </span>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        {actions.map((action) => (
          <Button
            key={action.id}
            size="sm"
            variant={action.primary ? "default" : "outline"}
            disabled={busy || action.disabled}
            title={action.message}
            onClick={() => onAction(action.id)}
          >
            {action.label}
          </Button>
        ))}
      </div>
    </div>
  );
}
