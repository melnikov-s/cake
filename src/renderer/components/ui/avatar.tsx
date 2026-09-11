import { Avatar as DiceBearAvatar, Style } from "@dicebear/core";
import gazeDefinition from "@dicebear/styles/gaze.json";
import sliceDefinition from "@dicebear/styles/slice.json";
import { useMemo, type HTMLAttributes } from "react";
import type { WorkflowStatusColor } from "../../../domain/application/application-data";
import { cn } from "../../lib/utils";
import { workflowStatusPalette } from "../../../utils/workflow-status-palette";

const styles = {
  project: new Style(sliceDefinition),
  session: new Style(gazeDefinition),
} as const;

const sessionBodyPlaceholder = "#abcdef";

export interface AvatarProps extends HTMLAttributes<HTMLSpanElement> {
  kind: "project" | "session";
  seed: string;
  statusColor?: WorkflowStatusColor;
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
          (statusColor
            ? "text-[attr(data-workflow-status-color_type(<color>))]"
            : "text-muted-foreground"),
        className,
      )}
      data-workflow-status-color={statusColor ? workflowStatusPalette[statusColor] : undefined}
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
