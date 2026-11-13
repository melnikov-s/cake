import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type PointerEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { useStore } from "r-state-tree/react";
import type { WidgetAttachment, WidgetSlot } from "../../contracts/widgets/widget-attachment";
import { RootStore } from "../stores/RootStore";
import {
  chatDropTargets,
  containsPoint,
  widgetDropOrder,
  type PlacementRect,
  type WidgetDropTarget,
} from "../lib/widget-placement";
import { cn } from "../lib/utils";

const WidgetPlacementContext = createContext<{
  pointer(event: PointerEvent<HTMLElement>, attachment: WidgetAttachment): void;
  keyboard(attachment: WidgetAttachment): void;
} | null>(null);

export function useWidgetPlacement() {
  return useContext(WidgetPlacementContext);
}

function visibleElement(selector: string) {
  return [...document.querySelectorAll<HTMLElement>(selector)].find((element) => {
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  });
}

function dropTargets(): WidgetDropTarget[] {
  const chat = visibleElement("[data-widget-chat]");
  const companion = visibleElement('[data-slot="workspace-companion-content"]');
  const workspace = visibleElement(
    '[data-slot="workspace-navigator"], [data-slot="workspace-companion-content"]',
  );
  // Keep the selected widget/header mounted while offering Chat edge destinations
  // over the companion body. The committed move, not hover, switches it to Chat.
  const rect =
    workspace && companion
      ? workspace.firstElementChild?.getBoundingClientRect()
      : workspace?.getBoundingClientRect();
  return [
    ...(chat
      ? chatDropTargets(chat.getBoundingClientRect())
      : companion
        ? (() => {
            const body = companion.getBoundingClientRect();
            const strip = companion.firstElementChild?.getBoundingClientRect();
            const top = strip ? strip.bottom : body.top;
            return chatDropTargets({
              left: body.left,
              top,
              width: body.width,
              height: Math.max(0, body.bottom - top),
            });
          })()
        : []),
    ...(rect
      ? [
          {
            slot: "tab" as const,
            rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
          },
        ]
      : []),
  ];
}

/** Transient input/DOM state only. Attachment authority stays in the application store. */
export function WidgetPlacement({ children }: { children: ReactNode }) {
  const root = useStore(RootStore);
  const store = root.widgetAttachmentStore;
  const end = useRef<(() => void) | undefined>(undefined);
  const [preview, setPreview] = useState<{
    attachment: WidgetAttachment;
    targets: WidgetDropTarget[];
    slot?: WidgetSlot;
    keyboard: boolean;
    order?: number;
    marker?: PlacementRect;
  }>();
  const [message, setMessage] = useState("");
  useEffect(() => () => end.current?.(), []);

  const reportFailure = (message: string) =>
    root.toastStore.show({
      tone: "error",
      title: "Widget not moved",
      message,
    });
  const commit = (attachment: WidgetAttachment, slot: WidgetSlot, order?: number) => {
    const current = store.attachments.find((entry) => entry.id === attachment.id);
    if (!current) return;
    const siblings = store.attachments.filter(
      (entry) => entry.slot === slot && entry.id !== current.id,
    );
    const last = Math.max(-1, ...siblings.map((entry) => entry.order));
    void store
      .move(current, slot, order ?? last + 1)
      .then(() => {
        if (slot === "tab") root.workspaceNavigatorStore.showWidget(current.id);
        else if (root.workspaceNavigatorStore.inCompanion) root.workspaceNavigatorStore.showChat();
        setMessage(`Moved ${store.title(current)} to ${slot === "tab" ? "Workspace" : slot}.`);
      })
      .catch((error: unknown) =>
        reportFailure(error instanceof Error ? error.message : String(error)),
      );
  };

  const pointer = (event: PointerEvent<HTMLElement>, attachment: WidgetAttachment) => {
    if (event.button !== 0 || end.current) return;
    event.preventDefault();
    const handle = event.currentTarget;
    const pointerId = event.pointerId;
    const startX = event.clientX;
    const startY = event.clientY;
    let active = false;
    let chosen: WidgetDropTarget | undefined;
    let order: number | undefined;
    const finish = () => {
      end.current = undefined;
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerup", release, true);
      window.removeEventListener("pointercancel", cancel, true);
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("blur", finish);
      document.removeEventListener("visibilitychange", visibility);
      handle.removeEventListener("lostpointercapture", finish);
      if (handle.hasPointerCapture?.(pointerId)) handle.releasePointerCapture(pointerId);
      setPreview(undefined);
    };
    const move = (event: globalThis.PointerEvent) => {
      if (event.pointerId !== pointerId) return;
      if (!(event.buttons & 1)) return finish();
      if (!active && Math.hypot(event.clientX - startX, event.clientY - startY) < 4) return;
      active = true;
      const targets = dropTargets();
      // Edge zones are disjoint and always win, even when a pane fills the chat.
      chosen = targets.find((target) => containsPoint(target.rect, event.clientX, event.clientY));
      // Reorder in an occupied interior independently of the edge destinations.
      if (!chosen) {
        const occupied = [...document.querySelectorAll<HTMLElement>("[data-widget-slot]")].find(
          (element) => {
            const rect = element.getBoundingClientRect();
            return (
              rect.width > 0 && rect.height > 0 && containsPoint(rect, event.clientX, event.clientY)
            );
          },
        );
        const slot = occupied?.dataset.widgetSlot;
        if (
          occupied &&
          (slot === "left" || slot === "right" || slot === "top" || slot === "bottom")
        )
          chosen = { slot, rect: occupied.getBoundingClientRect() };
      }
      order = undefined;
      let marker: PlacementRect | undefined;
      if (chosen && chosen.slot !== "tab") {
        const slot = visibleElement(`[data-widget-slot="${chosen.slot}"]`);
        const siblings = [
          ...(slot?.querySelectorAll<HTMLElement>("[data-widget-attachment]") ?? []),
        ]
          .filter((element) => element.dataset.widgetAttachment !== attachment.id)
          .flatMap((element) => {
            const entry = store.attachments.find(
              (entry) => entry.id === element.dataset.widgetAttachment,
            );
            if (!entry) return [];
            // Orders sent to attachWidget are indexed after removal of the source.
            return [
              {
                id: entry.id,
                order:
                  entry.order -
                  (attachment.slot === entry.slot && attachment.order < entry.order ? 1 : 0),
                rect: element.getBoundingClientRect(),
              },
            ];
          });
        order = widgetDropOrder(siblings, event.clientY);
        const before = siblings.find((entry) => entry.order === order);
        const last = siblings.at(-1);
        const rect = before?.rect ?? last?.rect;
        if (rect)
          marker = {
            left: rect.left,
            top: before ? rect.top : rect.bottom,
            width: rect.width,
            height: 2,
          };
      }
      setPreview({ attachment, targets, slot: chosen?.slot, order, marker, keyboard: false });
    };
    const release = (event: globalThis.PointerEvent) => {
      if (event.pointerId !== pointerId) return;
      const destination = chosen;
      finish();
      if (active && destination) commit(attachment, destination.slot, order);
    };
    const cancel = (event: globalThis.PointerEvent) => {
      if (event.pointerId === pointerId) finish();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      finish();
    };
    const visibility = () => {
      if (document.hidden) finish();
    };
    end.current = finish;
    window.addEventListener("pointermove", move, true);
    window.addEventListener("pointerup", release, true);
    window.addEventListener("pointercancel", cancel, true);
    window.addEventListener("keydown", key, true);
    window.addEventListener("blur", finish);
    document.addEventListener("visibilitychange", visibility);
    handle.addEventListener("lostpointercapture", finish);
    handle.setPointerCapture?.(pointerId);
  };

  const keyboard = (attachment: WidgetAttachment) => {
    if (end.current) return;
    const targets = dropTargets();
    let slot = attachment.slot;
    let order = attachment.order;
    const update = () => setPreview({ attachment, targets, slot, order, keyboard: true });
    const finish = () => {
      end.current = undefined;
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("blur", finish);
      setPreview(undefined);
    };
    const key = (event: KeyboardEvent) => {
      const slots = {
        ArrowUp: "top",
        ArrowDown: "bottom",
        ArrowLeft: "left",
        ArrowRight: "right",
        w: "tab",
        W: "tab",
      } satisfies Record<string, WidgetSlot>;
      const destination = Object.entries(slots).find(([key]) => key === event.key)?.[1];
      if (
        !["Escape", "Enter", " ", "PageUp", "PageDown", "Tab", ...Object.keys(slots)].includes(
          event.key,
        )
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape" || event.key === "Tab") return finish();
      if (event.key === "Enter" || event.key === " ") {
        finish();
        if (targets.some((target) => target.slot === slot)) commit(attachment, slot, order);
        return;
      }
      if (event.key === "PageUp") order = Math.max(0, order - 1);
      else if (event.key === "PageDown") order += 1;
      else if (destination) {
        slot = destination;
        order =
          slot === attachment.slot
            ? attachment.order
            : store.attachments.filter((entry) => entry.slot === slot).length;
      }
      update();
    };
    end.current = finish;
    window.addEventListener("keydown", key, true);
    window.addEventListener("blur", finish);
    update();
  };
  return (
    <WidgetPlacementContext value={{ pointer, keyboard }}>
      {children}
      <span role="status" className="sr-only">
        {message}
      </span>
      {preview &&
        createPortal(
          <div
            data-widget-placement-overlay
            className={cn(
              "fixed inset-0 z-[100] select-none",
              preview.keyboard ? "pointer-events-none" : "cursor-grabbing touch-none",
            )}
          >
            {preview.targets.map((target) => (
              <div
                key={target.slot}
                data-widget-drop-target={target.slot}
                className={cn(
                  "pointer-events-none absolute flex items-center justify-center rounded-md border border-dashed border-accent bg-accent/10 text-sm text-foreground",
                  preview.slot === target.slot && "border-solid bg-accent/25 ring-2 ring-accent",
                )}
                style={target.rect}
              >
                {target.slot === "tab"
                  ? "Workspace"
                  : root.workspaceNavigatorStore.inCompanion
                    ? `Chat · ${target.slot}`
                    : target.slot}
              </div>
            ))}
            {preview.marker && (
              <div
                data-widget-insertion-marker
                className="pointer-events-none absolute bg-accent"
                style={preview.marker}
              />
            )}
            <div
              role="status"
              className="pointer-events-none absolute inset-x-0 bottom-4 mx-auto w-fit max-w-full rounded-md border border-border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-sm"
            >
              {preview.keyboard
                ? `Move widget: ${preview.slot}, position ${(preview.order ?? 0) + 1}. Arrow keys: edge · W: Workspace · Page Up/Down: order · Enter: place · Escape: cancel`
                : "Drop to place widget · Escape to cancel"}
            </div>
          </div>,
          document.body,
        )}
    </WidgetPlacementContext>
  );
}
