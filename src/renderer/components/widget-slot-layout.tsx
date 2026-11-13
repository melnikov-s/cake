import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { WidgetSlot } from "../../contracts/widgets/widget-attachment";
import { allocateWidgetPair } from "../lib/widget-slot-sizing";

type Edge = Exclude<WidgetSlot, "tab">;
const opposite = { top: "bottom", bottom: "top", left: "right", right: "left" } as const;
const initialSizes = { top: 160, bottom: 160, left: 280, right: 280 };
const WidgetSlotLayoutContext = createContext<{
  sizes: Record<Edge, number>;
  width: number;
  height: number;
  register(slot: Edge, present: boolean): void;
  resize(slot: Edge, size: number): void;
} | null>(null);

/** One geometry/request owner per chat. Never derive a pane's limit from its peer's rendered size. */
export function WidgetSlotLayout({
  children,
  enabled = true,
}: {
  children: ReactNode;
  enabled?: boolean;
}) {
  const element = useRef<HTMLDivElement>(null);
  const [bounds, setBounds] = useState({ width: 0, height: 0 });
  const [requested, setRequested] = useState(initialSizes);
  const [present, setPresent] = useState<Partial<Record<Edge, boolean>>>({});
  const register = useCallback((slot: Edge, value: boolean) => {
    setPresent((previous) =>
      previous[slot] === value ? previous : { ...previous, [slot]: value },
    );
  }, []);
  useLayoutEffect(() => {
    const container = element.current;
    if (!container || !enabled) return;
    const measure = () => {
      const { width, height } = container.getBoundingClientRect();
      setBounds((previous) =>
        previous.width === width && previous.height === height ? previous : { width, height },
      );
    };
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    measure();
    return () => observer.disconnect();
  }, [enabled]);
  const [left, right] = allocateWidgetPair(
    bounds.width,
    present.left ? requested.left : 0,
    present.right ? requested.right : 0,
  );
  const [top, bottom] = allocateWidgetPair(
    bounds.height,
    present.top ? requested.top : 0,
    present.bottom ? requested.bottom : 0,
  );
  const resize = (slot: Edge, size: number) => {
    const available = slot === "left" || slot === "right" ? bounds.width : bounds.height;
    const value = Math.max(0, Math.min(size, available));
    setRequested((previous) => ({
      ...previous,
      [slot]: value,
      // An explicit resize has priority; window resizing instead scales both requests equally.
      [opposite[slot]]: present[opposite[slot]]
        ? Math.min(previous[opposite[slot]], available - value)
        : previous[opposite[slot]],
    }));
  };
  return (
    <WidgetSlotLayoutContext
      value={{ sizes: { left, right, top, bottom }, ...bounds, register, resize }}
    >
      <div
        ref={element}
        data-widget-chat={enabled ? "" : undefined}
        className="relative flex h-full min-h-0 min-w-0 flex-col"
      >
        {children}
      </div>
    </WidgetSlotLayoutContext>
  );
}

export function useWidgetSlotLayout() {
  const layout = useContext(WidgetSlotLayoutContext);
  if (!layout) throw new Error("WidgetSlot requires WidgetSlotLayout");
  return layout;
}
