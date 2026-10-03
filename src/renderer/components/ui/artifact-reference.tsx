import { Link, type LinkProps } from "@/components/ui/link";
import { cn } from "@/lib/utils";

/** Transcript provenance link for a deliverable shown in the artifact workspace. */
export function ArtifactReference({ className, children, ...props }: LinkProps) {
  return (
    <Link className={cn("text-xs", className)} {...props}>
      Artifact created · {children}
    </Link>
  );
}
