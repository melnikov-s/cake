import { Avatar as DiceBearAvatar, Style } from "@dicebear/core";
import gazeDefinition from "@dicebear/styles/gaze.json";
import sliceDefinition from "@dicebear/styles/slice.json";
import { useMemo, type HTMLAttributes } from "react";
import type { ProjectWorkflowColor } from "../../../domain/application/application-data";
import { cn } from "../../lib/utils";

const styles = {
  project: new Style(sliceDefinition),
  session: new Style(gazeDefinition),
} as const;

const statusColorClasses = {
  rose: "text-workflow-rose",
  peach: "text-workflow-peach",
  amber: "text-workflow-amber",
  lime: "text-workflow-lime",
  mint: "text-workflow-mint",
  sky: "text-workflow-sky",
  blue: "text-workflow-blue",
  violet: "text-workflow-violet",
} satisfies Record<ProjectWorkflowColor, string>;

const sessionBodyPlaceholder = "#abcdef";

export interface AvatarProps extends HTMLAttributes<HTMLSpanElement> {
  kind: "project" | "session";
  seed: string;
  statusColor?: ProjectWorkflowColor;
}

/** Deterministic DiceBear avatar with Cake-owned sizing, status color, and accessibility. */
export function Avatar({ kind, seed, statusColor, className, ...props }: AvatarProps) {
  const avatar = useMemo(() => {
    if (kind === "project") {
      return {
        uri: new DiceBearAvatar(styles.project, {
          seed,
          backgroundColor: "#00000000",
        }).toDataUri(),
      };
    }

    const svg = new DiceBearAvatar(styles.session, {
      seed,
      bodyColor: sessionBodyPlaceholder,
    })
      .toString()
      .replace(/<metadata[\s\S]*?<\/metadata>/, "")
      .replaceAll(sessionBodyPlaceholder, "currentColor");
    return { svg };
  }, [kind, seed]);

  return (
    <span
      data-slot="avatar"
      className={cn(
        "inline-grid size-5 shrink-0 place-items-center [&_svg]:size-full",
        kind === "session" &&
          (statusColor ? statusColorClasses[statusColor] : "text-muted-foreground"),
        className,
      )}
      {...props}
    >
      {"uri" in avatar ? (
        <img className="size-full" src={avatar.uri} alt="" aria-hidden="true" />
      ) : (
        <span className="contents" dangerouslySetInnerHTML={{ __html: avatar.svg }} />
      )}
    </span>
  );
}
