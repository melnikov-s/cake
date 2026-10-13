import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ResizeHandle } from "./resize-handle";

/** View-local geometry; never stored in the document rendered by the surface. */
export function ResizableSurface({
  children,
  label,
  renderExpanded,
}: {
  children: ReactNode;
  label: string;
  renderExpanded?: (targetRef: (node: HTMLDivElement | null) => void) => ReactNode;
}) {
  const [height, setHeight] = useState(600);
  const inline = useRef<HTMLDivElement>(null);
  const [mount] = useState(() => {
    const element = document.createElement("div");
    element.className = "h-full min-h-0 w-full overflow-hidden";
    return element;
  });
  const move = useCallback(
    (target: HTMLDivElement | null) => {
      if (!target || mount.parentElement === target) return;
      if (!mount.isConnected) target.append(mount);
      else {
        // A normal append/reparent reloads iframe documents. Chromium's atomic
        // move preserves the browsing context, including unsaved editor state.
        // SAFETY: Electron 43's Chromium supports Element.moveBefore; our pinned
        // TypeScript DOM declarations predate this standard DOM method.
        (
          target as HTMLDivElement & { moveBefore(node: Node, child: Node | null): void }
        ).moveBefore(mount, null);
      }
    },
    [mount],
  );
  useLayoutEffect(() => move(inline.current), [move]);
  // Ref detachment runs before removal of the fullscreen DOM subtree. Restore
  // the connected iframe atomically then, not in a later layout effect.
  const expandedRef = useCallback(
    (node: HTMLDivElement | null) => move(node ?? inline.current),
    [move],
  );
  return (
    <div className="relative min-w-0">
      <div ref={inline} style={{ height }} />
      {createPortal(children, mount)}
      {renderExpanded?.(expandedRef)}
      {!renderExpanded && (
        <div className="relative h-7 border-t border-border text-center text-xs leading-7 text-muted-foreground">
          Drag to resize · arrow keys when focused
          <ResizeHandle
            label={`Resize ${label}`}
            value={height}
            min={240}
            max={1200}
            edge="top"
            className="inset-0 h-full after:bg-border"
            onChange={setHeight}
          />
        </div>
      )}
    </div>
  );
}
