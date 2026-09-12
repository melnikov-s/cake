import { Button, type ButtonProps } from "@/components/ui/button";
import { ArtifactIcon } from "@/components/ui/icons";
import { cn } from "@/lib/utils";

/** Compact transcript provenance link for a deliverable shown in the artifact workspace. */
export function ArtifactReference({ className, children, ...props }: ButtonProps) {
  return (
    <Button
      variant="outline"
      size="sm"
      className={cn("h-7 max-w-full gap-1.5 px-2 font-mono text-[11px]", className)}
      {...props}
    >
      <ArtifactIcon />
      <span className="shrink-0 text-muted-foreground">Artifact created</span>
      <span aria-hidden="true" className="text-muted-foreground/70">
        ·
      </span>
      <span className="truncate">{children}</span>
    </Button>
  );
}
