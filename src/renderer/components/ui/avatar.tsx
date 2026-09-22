import { Avatar as DiceBearAvatar, Style } from "@dicebear/core";
import gazeDefinition from "@dicebear/styles/gaze.json";
import sliceDefinition from "@dicebear/styles/slice.json";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type HTMLAttributes,
  type RefObject,
} from "react";
import {
  animateSessionAvatar,
  interactWithSessionAvatar,
  materializeSessionAvatar,
} from "../../lib/animate-session-avatar";
import type { ProjectIcon, SessionLabelColor } from "../../../domain/application/application-data";
import { cn } from "../../lib/utils";
import { mergedSessionLabelColor } from "../../../utils/session-label-color";

const styles = {
  project: new Style(sliceDefinition),
  session: new Style(gazeDefinition),
} as const;

const sessionBodyPlaceholder = "#abcdef";

export interface AvatarProps extends HTMLAttributes<HTMLSpanElement> {
  kind: "project" | "session";
  seed: string;
  labelColors?: readonly SessionLabelColor[];
  customIcon?: ProjectIcon;
  animated?: boolean;
  /** A session character disappears in a brief puff when resolved. */
  resolved?: boolean;
  /** Opt-in row feedback instead of idle animation; activationTarget is a NavItem. */
  interaction?: {
    target: RefObject<HTMLElement | null>;
    activationTarget: RefObject<HTMLElement | null>;
  };
}

/** Deterministic DiceBear avatar with Cake-owned sizing, status color, and accessibility. */
export function Avatar({
  kind,
  seed,
  labelColors,
  customIcon,
  animated = false,
  resolved = false,
  interaction,
  className,
  ...props
}: AvatarProps) {
  const host = useRef<HTMLSpanElement>(null);
  const instanceId = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const disappearing = kind === "session" && resolved;
  const [phase, setPhase] = useState<"visible" | "puff" | "gone">(
    disappearing ? "gone" : "visible",
  );
  const previousDisappearing = useRef(disappearing);
  useLayoutEffect(() => {
    if (previousDisappearing.current === disappearing) return;
    previousDisappearing.current = disappearing;
    setPhase(
      disappearing
        ? window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
          ? "gone"
          : "puff"
        : "visible",
    );
  }, [disappearing]);
  const materialized = !disappearing && (animated || Boolean(interaction));
  const interactionTarget = interaction?.target;
  const activationTarget = interaction?.activationTarget;
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
    return { __html: materialized ? materializeSessionAvatar(svg) : svg };
  }, [kind, seed, instanceId, materialized]);

  useEffect(() => {
    if (kind !== "session" || disappearing || !host.current) return;
    if (interactionTarget?.current && activationTarget?.current) {
      return interactWithSessionAvatar(
        host.current,
        interactionTarget.current,
        activationTarget.current,
      );
    }
    if (animated) return animateSessionAvatar(host.current);
  }, [animated, kind, disappearing, avatar, interactionTarget, activationTarget]);

  return (
    <span
      ref={host}
      data-slot="avatar"
      data-resolved={disappearing || undefined}
      data-animated={
        kind === "session" && !disappearing
          ? interaction
            ? "interaction"
            : animated
              ? "true"
              : undefined
          : undefined
      }
      className={cn(
        "relative inline-grid size-5 shrink-0 place-items-center [&_svg]:size-full",
        kind === "session" && "origin-bottom",
        kind === "session" &&
          (labelColors?.length
            ? "text-[attr(data-session-label-color_type(<color>))]"
            : "text-muted-foreground"),
        className,
      )}
      data-session-label-color={mergedSessionLabelColor(labelColors ?? [])}
      {...props}
    >
      {kind === "project" && customIcon ? (
        <img
          className="size-full object-contain"
          src={`data:${customIcon.mimeType};base64,${customIcon.data}`}
          alt=""
          aria-hidden="true"
        />
      ) : kind === "session" && disappearing && phase === "gone" ? null : "uri" in avatar ? (
        <img className="size-full" src={avatar.uri} alt="" aria-hidden="true" />
      ) : (
        <span
          data-slot="session-character"
          className={cn(
            "block size-full origin-bottom",
            phase === "puff"
              ? "animate-[session-avatar-vanish_450ms_ease-in_both]"
              : "motion-safe:animate-[session-avatar-appear_500ms_ease-out_both]",
          )}
          dangerouslySetInnerHTML={avatar}
        />
      )}
      {disappearing && phase === "puff" && (
        <span
          data-slot="session-smoke"
          aria-hidden="true"
          onAnimationEnd={(event) => {
            if (event.target === event.currentTarget) setPhase("gone");
          }}
          className="pointer-events-none absolute size-5 animate-[session-smoke-puff_450ms_ease-out_both]"
        >
          <span className="absolute left-[20%] top-[30%] size-[55%] rounded-full bg-muted-foreground/70 blur-[1px]" />
          <span className="absolute left-[45%] top-[15%] size-[55%] rounded-full bg-muted-foreground/60 blur-[1px]" />
          <span className="absolute left-[5%] top-[5%] size-[50%] rounded-full bg-muted-foreground/55 blur-[1px]" />
          <span className="absolute left-[50%] top-[50%] size-[40%] rounded-full bg-muted-foreground/50 blur-[1px]" />
        </span>
      )}
    </span>
  );
}
