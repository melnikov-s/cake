import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { observer, useStore } from "r-state-tree/react";
import { parseArtifactRef } from "../../../contracts/artifacts/artifact-lineage";
import type { CanvasTarget } from "../../../contracts/project-canvas/canvas-link";
import { RootStore } from "../../stores/RootStore";
import { cn } from "../../lib/utils";
import { ConversationBreadcrumb } from "../conversation-breadcrumb";
import { WorkspaceModeControls } from "../workspace-mode-controls";
import { WorkspaceHeader } from "../ui/workspace-header";
import { Button } from "../ui/button";
import { IconButton } from "../ui/icon-button";
import { SearchIcon, ResetZoomIcon, ZoomInIcon, ZoomOutIcon } from "../ui/icons";
import { CanvasGround } from "./canvas-ground";
import { CanvasSearch } from "./canvas-search";
import { CanvasStage } from "./canvas-stage";
import { CanvasTile } from "./canvas-tile";
import { fit, useCamera, zoomAt, type Cam } from "./camera";
import { layoutCanvas } from "./layout";

export const CanvasWorkspace = observer(function CanvasWorkspace({
  projectChatId,
  browserMode,
}: {
  projectChatId: string;
  browserMode: boolean;
}) {
  const root = useStore(RootStore);
  const store = root.projectCanvasStore;
  const presentation = root.projectWorkbenchStore.presentationStore;
  const title =
    root.cakeChatCollectionStore.summaries.find((item) => item.sessionId === projectChatId)
      ?.title ?? "Project";
  const viewport = useRef<HTMLDivElement>(null);
  const world = useRef<HTMLDivElement>(null);
  const zoomLabel = useRef<HTMLSpanElement>(null);
  const ground = useRef<Cam>({ x: 0, y: 0, z: 0.3 });
  const drag = useRef<{ id: number; x: number; y: number; start: Cam }>(undefined);
  const space = useRef(false);
  const ready = useRef(false);
  const [grabbing, setGrabbing] = useState(false);
  const [searching, setSearching] = useState(false);
  const [source, setSource] = useState<DOMRect>();
  const [status, setStatus] = useState("");
  const camera = useCamera((c) => {
    ground.current = c;
    if (world.current) {
      world.current.style.transform = `translate3d(${c.x}px, ${c.y}px, 0) scale(${c.z})`;
      world.current.style.setProperty("--canvas-z", String(c.z));
    }
    if (zoomLabel.current) zoomLabel.current.textContent = `${Math.round(c.z * 100)}%`;
  });
  const cards = store.model.cards;
  const layout = useMemo(() => layoutCanvas(cards), [cards]);
  const target = store.target?.projectChatId === projectChatId ? store.target : undefined;
  const card = cards.find((item) => item.id === target?.cardId);
  const revision =
    target?.revision === undefined
      ? card?.revisions.at(-1)
      : card?.revisions.find((item) => item.number === target.revision);
  const focusRect = (rect: typeof layout.rect, maxZoom = 0.88) => {
    const el = viewport.current;
    if (!el) return camera.now;
    const pad = Math.min(90, el.clientWidth * 0.08, el.clientHeight * 0.12);
    const fitted = fit(rect, el.clientWidth, el.clientHeight - 42, pad);
    const z = Math.min(fitted.z, maxZoom);
    return {
      z,
      x: el.clientWidth / 2 - (rect.x + rect.w / 2) * z,
      y: (el.clientHeight - 42) / 2 - (rect.y + rect.h / 2) * z,
    };
  };
  useEffect(() => store.connect(projectChatId), [store, projectChatId]);
  useLayoutEffect(() => {
    if (!store.loaded || !layout.groups.length || ready.current) return;
    ready.current = true;
    camera.jump(focusRect(layout.rect));
  }, [camera, layout, store.loaded]);
  useEffect(() => {
    if (!target || !store.loaded) return;
    if (!revision) return;
    const tile = layout.groups
      .flatMap((item) => item.tiles)
      .find((item) => item.card.id === target.cardId);
    if (tile) camera.glide(focusRect(tile, 1.05));
  }, [target, store.loaded, revision?.number, camera]);

  useEffect(() => {
    const el = viewport.current;
    if (!el) return;
    const wheel = (event: WheelEvent) => {
      if (event.target instanceof Element && event.target.closest("[data-canvas-chrome]")) return;
      event.preventDefault();
      const c = camera.now;
      const rect = el.getBoundingClientRect();
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? rect.height : 1;
      const dy = event.deltaY * unit;
      if (event.ctrlKey || event.metaKey)
        camera.jump(
          zoomAt(
            c,
            c.z * Math.exp(-dy * (event.ctrlKey ? 0.012 : 0.0028)),
            event.clientX - rect.left,
            event.clientY - rect.top,
          ),
        );
      else camera.jump({ ...c, x: c.x - event.deltaX * unit, y: c.y - dy });
    };
    const keyUp = (event: KeyboardEvent) => {
      if (event.code === "Space") space.current = false;
    };
    const blur = () => {
      space.current = false;
    };
    el.addEventListener("wheel", wheel, { passive: false });
    window.addEventListener("keyup", keyUp);
    window.addEventListener("blur", blur);
    return () => {
      el.removeEventListener("wheel", wheel);
      window.removeEventListener("keyup", keyUp);
      window.removeEventListener("blur", blur);
    };
  }, [camera]);

  const changeZoom = (factor: number) => {
    const el = viewport.current;
    if (el)
      camera.glide(
        zoomAt(camera.now, camera.now.z * factor, el.clientWidth / 2, el.clientHeight / 2),
      );
  };
  const open = (ref: CanvasTarget, from?: DOMRect) => {
    setStatus("");
    setSource(from);
    setSearching(false);
    store.reveal(ref);
  };
  const close = () => {
    store.closeReview();
    setSource(undefined);
  };
  const copy = (link: string) => {
    void navigator.clipboard.writeText(link).then(
      () => setStatus("Link copied"),
      () => setStatus("Could not copy link"),
    );
  };
  const modal = searching || Boolean(target && card && revision);
  return (
    <div className="flex size-full min-h-0 flex-col" aria-label="Project Canvas workspace">
      <WorkspaceHeader title={<ConversationBreadcrumb sessionId={projectChatId} />}>
        <WorkspaceModeControls
          mode="canvas"
          browserHost={browserMode}
          ideAvailable
          terminalAvailable={root.terminalStore.available}
          terminalOpen={root.terminalStore.open}
          onToggleTerminal={() => void root.terminalStore.toggle()}
          onBackToAgent={() => {
            close();
            void presentation.backToAgent();
          }}
          onOpenCanvas={() => {}}
          onOpenBrowser={() => void presentation.openBrowser()}
          onOpenIde={() => void presentation.openIde()}
        />
      </WorkspaceHeader>
      <div
        ref={viewport}
        aria-label="Canvas board"
        tabIndex={0}
        className={cn(
          "relative isolate min-h-0 flex-1 touch-none overflow-hidden bg-linear-to-br from-background to-muted select-none outline-none",
          grabbing ? "cursor-grabbing" : "cursor-grab",
        )}
        onScroll={(event) => {
          event.currentTarget.scrollLeft = 0;
          event.currentTarget.scrollTop = 0;
        }}
        onKeyDown={(e) => {
          if (modal || (e.target instanceof Element && e.target.closest("input, textarea"))) return;
          if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f") {
            e.preventDefault();
            e.stopPropagation();
            setSearching(true);
            return;
          }
          if (e.target !== e.currentTarget) return;
          if (e.code === "Space") {
            space.current = true;
            e.preventDefault();
          }
          const moves = {
            ArrowLeft: [70, 0],
            ArrowRight: [-70, 0],
            ArrowUp: [0, 70],
            ArrowDown: [0, -70],
          } as const;
          const key = e.key;
          const move =
            key === "ArrowLeft" || key === "ArrowRight" || key === "ArrowUp" || key === "ArrowDown"
              ? moves[key]
              : undefined;
          if (move) {
            e.preventDefault();
            camera.jump({ ...camera.now, x: camera.now.x + move[0], y: camera.now.y + move[1] });
          }
          if (e.key === "+" || e.key === "=") changeZoom(1.25);
          if (e.key === "-") changeZoom(0.8);
          if (e.key === "0") camera.glide(focusRect(layout.rect));
        }}
        onPointerDownCapture={(e) => {
          if (modal || !(e.target instanceof Element) || e.target.closest("[data-canvas-chrome]"))
            return;
          if (
            !(
              e.button === 1 ||
              (e.button === 0 && (space.current || !e.target.closest("button, a")))
            )
          )
            return;
          e.preventDefault();
          e.stopPropagation();
          const at = camera.now;
          camera.jump(at);
          drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, start: at };
          e.currentTarget.focus({ preventScroll: true });
          e.currentTarget.setPointerCapture(e.pointerId);
          setGrabbing(true);
        }}
        onPointerMove={(e) => {
          const from = drag.current;
          if (from?.id === e.pointerId)
            camera.jump({
              ...from.start,
              x: from.start.x + e.clientX - from.x,
              y: from.start.y + e.clientY - from.y,
            });
        }}
        onLostPointerCapture={() => {
          drag.current = undefined;
          setGrabbing(false);
        }}
      >
        <CanvasGround cam={ground} />
        <div inert={modal} className="absolute inset-0" aria-hidden={modal || undefined}>
          <div
            ref={world}
            data-testid="canvas-world"
            className="absolute top-0 left-0 origin-top-left will-change-transform"
          >
            {layout.groups.length > 0 && (
              <div
                className="absolute top-[72px] left-0 flex items-end gap-8"
                style={{ width: layout.rect.w }}
              >
                <Button
                  variant="ghost"
                  onClick={() => camera.glide(focusRect(layout.rect))}
                  className="block h-auto min-w-0 truncate p-0 font-display text-[max(56px,min(160px,calc(38px/var(--canvas-z,1))))] leading-none font-semibold tracking-[-0.045em] text-foreground/90 hover:bg-transparent"
                >
                  {title}
                </Button>
                <span className="mb-1 shrink-0 font-mono text-sm text-muted-foreground">
                  Project Canvas
                </span>
              </div>
            )}
            {layout.groups.map((group) => (
              <div key={group.name}>
                <div
                  className="absolute flex items-center gap-3"
                  style={{ left: group.x, top: group.y, width: Math.max(420, group.w) }}
                >
                  <Button
                    variant="ghost"
                    onClick={() => camera.glide(focusRect(group, 1.15))}
                    className="h-auto max-w-full min-w-0 truncate p-0 text-[max(17px,min(72px,calc(13px/var(--canvas-z,1))))] font-semibold tracking-tight text-foreground hover:bg-transparent"
                  >
                    {group.name}
                  </Button>
                  <time
                    className="shrink-0 font-mono text-xs text-muted-foreground"
                    dateTime={group.at}
                  >
                    {new Date(group.at).toLocaleDateString(undefined, {
                      month: "short",
                      day: "numeric",
                    })}
                  </time>
                </div>
                {group.tiles.map((tile) => (
                  <CanvasTile
                    key={tile.card.id}
                    tile={tile}
                    projectChatId={projectChatId}
                    store={store}
                    open={open}
                    copy={copy}
                  />
                ))}
              </div>
            ))}
          </div>
          {!layout.groups.length && (
            <div className="pointer-events-none absolute inset-0 grid place-content-center px-6 text-center">
              <h1 className="font-display text-4xl font-semibold tracking-tight text-foreground/90">
                {store.loaded
                  ? "Nothing on the Canvas yet"
                  : store.error
                    ? "Canvas unavailable"
                    : "Project Canvas"}
              </h1>
              <p className="mt-3 text-sm text-muted-foreground">
                {store.error ??
                  (store.loaded
                    ? "Ask Project Chat to publish screenshots, artifacts, or decisions for review."
                    : "Loading…")}
              </p>
            </div>
          )}
          {target && store.loaded && !revision && (
            <div
              className="absolute top-4 left-1/2 flex -translate-x-1/2 items-center gap-3 rounded-full bg-popover px-3 py-1 shadow"
              data-canvas-chrome
              role="alert"
            >
              This Canvas revision was not found.{" "}
              <Button size="sm" variant="ghost" onClick={close}>
                Dismiss
              </Button>
            </div>
          )}
          <div
            data-canvas-chrome
            className="absolute bottom-6 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-full border border-border/75 bg-popover/90 p-1.5 shadow-xl backdrop-blur-xl"
          >
            <IconButton tooltip="Search Canvas" onClick={() => setSearching(true)}>
              <SearchIcon />
            </IconButton>
            <span className="mx-0.5 h-4 w-px bg-border" />
            <IconButton tooltip="Zoom out" onClick={() => changeZoom(0.8)}>
              <ZoomOutIcon />
            </IconButton>
            <span
              ref={zoomLabel}
              className="w-10 text-center font-mono text-xs text-muted-foreground"
            >
              {Math.round(camera.now.z * 100)}%
            </span>
            <IconButton tooltip="Zoom in" onClick={() => changeZoom(1.25)}>
              <ZoomInIcon />
            </IconButton>
            <IconButton tooltip="Fit board" onClick={() => camera.glide(focusRect(layout.rect))}>
              <ResetZoomIcon />
            </IconButton>
          </div>
        </div>
        <div
          className="pointer-events-none absolute top-4 right-4 z-60 text-xs text-muted-foreground"
          role="status"
        >
          {status}
        </div>
        {searching && viewport.current && (
          <CanvasSearch
            cards={cards}
            projectChatId={projectChatId}
            portal={viewport.current}
            pick={open}
            close={() => setSearching(false)}
          />
        )}
        {target && card && revision && viewport.current && (
          <CanvasStage
            key={`${card.id}:${revision.number}`}
            card={card}
            revision={revision}
            target={target}
            store={store}
            source={source}
            portal={viewport.current}
            copy={copy}
            close={close}
            openArtifact={(reference) => {
              const exact = parseArtifactRef(reference);
              close();
              root.navigationStore.openArtifact(projectChatId, exact.lineageId, exact.revision);
            }}
            handoff={(sessionId, text) => root.draftCanvasFeedback(sessionId, text)}
          />
        )}
      </div>
    </div>
  );
});
