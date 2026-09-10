import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { observer } from "r-state-tree/react";
import { ResizeHandle } from "@/components/ui/resize-handle";
import { SidePanel } from "@/components/ui/side-panel";
import type { ChatStore } from "../stores/ChatStore";
import type { SideChatStore } from "../stores/SideChatStore";
import { SideChatContext } from "./side-chat-context";

const SIDE_BY_SIDE_MIN_WIDTH = 860;
const MIN_SIDE_CHAT_WIDTH = 320;

export const SideChatLayout = observer(function SideChatLayout({
  store,
  children,
  renderChat,
}: {
  store: SideChatStore;
  children: ReactNode;
  renderChat(store: ChatStore): ReactNode;
}) {
  const layoutRef = useRef<HTMLDivElement>(null);
  const [availableWidth, setAvailableWidth] = useState(0);

  useLayoutEffect(() => {
    const layout = layoutRef.current;
    if (!layout) return;
    const update = () => setAvailableWidth(layout.getBoundingClientRect().width);
    update();
    if (!("ResizeObserver" in globalThis)) return;
    const resizeObserver = new globalThis.ResizeObserver(update);
    resizeObserver.observe(layout);
    return () => resizeObserver.disconnect();
  }, []);

  const target = store.target;
  const sideBySide = Boolean(target && availableWidth >= SIDE_BY_SIDE_MIN_WIDTH);
  const maximumWidth = Math.max(MIN_SIDE_CHAT_WIDTH, availableWidth * 0.6);
  const sideChatWidth = Math.min(maximumWidth, Math.max(MIN_SIDE_CHAT_WIDTH, store.width));
  const style: CSSProperties & Record<"--side-chat-width", string> = {
    "--side-chat-width": `${sideChatWidth}px`,
  };

  return (
    <SideChatContext.Provider value={store}>
      <div
        ref={layoutRef}
        data-slot="side-chat-layout"
        data-presentation={target ? (sideBySide ? "side-by-side" : "replacement") : "closed"}
        className={
          target && sideBySide
            ? "grid h-full min-h-0 min-w-0 grid-cols-[minmax(0,1fr)_9px_var(--side-chat-width)] overflow-hidden"
            : "grid h-full min-h-0 min-w-0 grid-cols-1 grid-rows-1 overflow-hidden"
        }
        style={style}
      >
        <div
          className={
            target && !sideBySide
              ? "invisible pointer-events-none col-start-1 row-start-1 h-full min-h-0 min-w-0 overflow-hidden"
              : "h-full min-h-0 min-w-0 overflow-hidden"
          }
        >
          {children}
        </div>
        {target && sideBySide && (
          <div className="relative z-30 bg-border/35">
            <ResizeHandle
              className="inset-0 h-full w-full"
              label="Resize side chat"
              value={sideChatWidth}
              min={MIN_SIDE_CHAT_WIDTH}
              max={maximumWidth}
              edge="right"
              onChange={(width) => store.setWidth(width)}
            />
          </div>
        )}
        {target && (
          <SidePanel
            className={sideBySide ? "border-l border-border/65" : "col-start-1 row-start-1"}
            title={target.title}
            eyebrow={target.eyebrow()}
            onClose={() => store.close()}
          >
            {renderChat(target.chatStore)}
          </SidePanel>
        )}
      </div>
    </SideChatContext.Provider>
  );
});
