import { Avatar as DiceBearAvatar, Style } from "@dicebear/core";
import gazeDefinition from "@dicebear/styles/gaze.json";
import sliceDefinition from "@dicebear/styles/slice.json";
import { useEffect, useId, useMemo, useRef, type HTMLAttributes } from "react";
import { animateSessionAvatar, materializeSessionAvatar } from "../../lib/animate-session-avatar";
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
  animated?: boolean;
}

/** Deterministic DiceBear avatar with Cake-owned sizing, status color, and accessibility. */
export function Avatar({
  kind,
  seed,
  statusColor,
  animated = false,
  className,
  ...props
}: AvatarProps) {
  const host = useRef<HTMLSpanElement>(null);
  const instanceId = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const avatar = useMemo(() => {
    if (kind === "project") {
      return {
        uri: new DiceBearAvatar(styles.project, {
          seed,
          backgroundColor: "#00000000",
        }).toDataUri(),
      };
    }

    let svg = new DiceBearAvatar(styles.session, {
      seed,
      bodyColor: sessionBodyPlaceholder,
    })
      .toString()
      .replace(/<metadata[\s\S]*?<\/metadata>/, "")
      .replaceAll(sessionBodyPlaceholder, "currentColor");
    // Repeated seeds appear in the sidebar, transcript, and composer together.
    for (const match of Array.from(svg.matchAll(/id="([^"]+)"/g))) {
      svg = svg.replaceAll(match[1]!, `${match[1]}-${instanceId}`);
    }
    return { __html: animated ? materializeSessionAvatar(svg) : svg };
  }, [kind, seed, instanceId, animated]);

  useEffect(() => {
    if (animated && kind === "session" && host.current) {
      return animateSessionAvatar(host.current);
    }
  }, [animated, kind, avatar]);

  return (
    <span
      ref={host}
      data-slot="avatar"
      data-animated={animated && kind === "session" ? "true" : undefined}
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
        <span className="contents" dangerouslySetInnerHTML={avatar} />
      )}
    </span>
  );
}
