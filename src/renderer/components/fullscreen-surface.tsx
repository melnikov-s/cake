import {
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  type ComponentProps,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { useStore } from "r-state-tree/react";
import { IconButton } from "@/components/ui/icon-button";
import { CloseIcon } from "@/components/ui/icons";
import { cn } from "@/lib/utils";
import { FullscreenSurfaceStore } from "../stores/FullscreenSurfaceStore";
import { WorkspaceChatLayout } from "./workspace-chat-layout";
import { FullscreenTranscriptContext } from "./fullscreen-transcript-context";
import { FullscreenViewportContext } from "./fullscreen-viewport-context";

export function FullscreenSurface({
  children,
  eyebrow,
  mode = "reader",
  onClose,
  title,
  toolbar,
  chatSidebar,
}: {
  children: ReactNode;
  eyebrow?: string;
  mode?: "reader" | "canvas" | "dialog";
  onClose(): void;
  title: string;
  toolbar?: ReactNode;
  chatSidebar?: Pick<
    ComponentProps<typeof WorkspaceChatLayout>,
    "chatSidebar" | "chatSidebarVisible" | "chatSidebarWidth" | "onChatSidebarWidthChange"
  >;
}) {
  const fullscreenSurfaces = useStore(FullscreenSurfaceStore);
  const transcript = useContext(FullscreenTranscriptContext);
  const viewport = useContext(FullscreenViewportContext);
  useLayoutEffect(() => transcript?.retain(), [transcript]);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  const surfaceId = useRef(crypto.randomUUID()).current;
  const titleId = useId();
  onCloseRef.current = onClose;

  useEffect(
    () => fullscreenSurfaces.open(surfaceId, () => onCloseRef.current()),
    [fullscreenSurfaces, surfaceId],
  );

  useEffect(() => {
    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    if (!surfaceRef.current?.contains(document.activeElement)) closeButton.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      // Fullscreen surfaces sit directly below the shared overlay band, so
      // nested layers (diagram/table fullscreen, image preview, dialogs) stack
      // above and handle Escape themselves. Only dismiss when this surface owns
      // the viewport center, i.e. nothing is stacked above. Environments without
      // layout (unit tests) are treated as topmost.
      const topmost = document.elementFromPoint?.(window.innerWidth / 2, window.innerHeight / 2);
      if (topmost && surfaceRef.current && !surfaceRef.current.contains(topmost)) return;
      // Claim this dismissal before the window-level Escape handler can close
      // the accessory pane underneath the fullscreen surface as well.
      event.preventDefault();
      onCloseRef.current();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      // Returning focus to a transcript control must not scroll the transcript.
      if (previouslyFocused?.isConnected) previouslyFocused.focus({ preventScroll: true });
    };
  }, []);

  const showEyebrow =
    Boolean(eyebrow?.trim()) && eyebrow?.trim().toLowerCase() !== title.trim().toLowerCase();

  const content = (
    <main
      className={cn(
        "flex h-full min-h-0 flex-1 justify-center overflow-auto px-8 py-8 max-[620px]:px-4 max-[620px]:py-5",
        mode === "canvas" && "overflow-hidden p-0 max-[620px]:p-0",
        mode === "dialog" && "items-center p-6",
      )}
    >
      <article
        className={cn(
          "w-full max-w-3xl",
          mode === "canvas" && "h-full min-h-0 max-w-none overflow-hidden",
          mode === "dialog" && "max-w-[34rem]",
        )}
        onMouseDown={(event) => event.stopPropagation()}
      >
        {children}
      </article>
    </main>
  );

  return createPortal(
    // z-45 keeps the surface above all workbench content while staying below
    // the shared z-50 overlay band, so overlays opened from within this surface
    // (e.g. a diagram's own fullscreen view) stack on top of it.
    <div
      ref={surfaceRef}
      className={cn(
        "inset-0 z-45 flex flex-col bg-background text-foreground motion-safe:animate-fade-in",
        viewport ? "absolute" : "fixed",
        mode === "dialog" && "bg-background/85 backdrop-blur-md",
      )}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      onMouseDown={mode === "dialog" ? onClose : undefined}
    >
      <header
        className="box-content flex h-title-bar shrink-0 items-center justify-between gap-4 border-b border-border/65 bg-background/95 pr-3.5 pl-[84px] backdrop-blur-md [-webkit-app-region:drag]"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {showEyebrow && (
            <span
              title={eyebrow}
              className="max-w-[26rem] shrink-0 truncate rounded-sm border border-border/70 bg-muted/60 px-1.5 py-0.5 text-xs font-medium text-muted-foreground"
            >
              {eyebrow}
            </span>
          )}
          <h2
            id={titleId}
            className="min-w-0 truncate text-xs font-semibold tracking-tight text-foreground"
          >
            {title}
          </h2>
        </div>
        <div className="flex shrink-0 items-center gap-1.5 [-webkit-app-region:no-drag]">
          {toolbar}
          {toolbar && <div className="mx-0.5 h-4 w-px shrink-0 bg-border/60" aria-hidden="true" />}
          <IconButton
            ref={closeButton}
            tooltip="Exit fullscreen"
            ariaLabel={`Exit fullscreen ${title}`}
            onClick={onClose}
          >
            <CloseIcon />
          </IconButton>
        </div>
      </header>
      {chatSidebar ? (
        <div
          className="min-h-0 flex-1"
          onMouseDown={(event) => {
            if (event.target instanceof Element && event.target.closest("aside, [role=separator]"))
              event.stopPropagation();
          }}
        >
          <WorkspaceChatLayout
            {...chatSidebar}
            className="h-full w-full"
            workspaceLabel={title}
            workspace={content}
          />
        </div>
      ) : (
        content
      )}
    </div>,
    viewport ?? document.body,
  );
}
