import {
  createContext,
  forwardRef,
  useContext,
  type ButtonHTMLAttributes,
  type ReactNode,
  type Ref,
} from "react";
import { observer } from "r-state-tree/react";
import type { CakeHotkeyActionId } from "../../../domain/application/cake-settings-data";
import { formatHotkey } from "@/lib/hotkeys";
import { cn } from "@/lib/utils";
import { TooltipBubble, useTooltip } from "./tooltip";

const HotkeyBindingsContext = createContext<((id: CakeHotkeyActionId) => string) | null>(null);

export function IconButtonHotkeyProvider({
  bindingFor,
  children,
}: {
  bindingFor: (id: CakeHotkeyActionId) => string;
  children: ReactNode;
}) {
  return (
    <HotkeyBindingsContext.Provider value={bindingFor}>{children}</HotkeyBindingsContext.Provider>
  );
}

/** Supply an accessible name explicitly when omitting the tooltip. */
export type IconButtonProps = Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "title" | "aria-label"
> & { hotkey?: CakeHotkeyActionId } & (
    | { tooltip: string; ariaLabel?: string }
    | { tooltip?: undefined; ariaLabel: string }
  );

/** Square transparent button for a single icon; tooltips show quickly by default. */
const ObservedIconButton = observer(function ObservedIconButton({
  tooltip,
  hotkey,
  ariaLabel,
  type = "button",
  className,
  children,
  onMouseEnter,
  onMouseLeave,
  onMouseDown,
  onFocus,
  onBlur,
  buttonRef,
  ...props
}: IconButtonProps & { buttonRef?: Ref<HTMLButtonElement> }) {
  const { anchor, hide, show } = useTooltip();
  const bindingFor = useContext(HotkeyBindingsContext);
  const binding = hotkey && bindingFor?.(hotkey);
  const label = tooltip && binding ? `${tooltip} (${formatHotkey(binding)})` : tooltip;

  return (
    <button
      ref={buttonRef}
      type={type}
      className={cn(
        "icon-button grid size-[30px] place-items-center rounded-[7px] border-0 bg-transparent text-muted-foreground hover:bg-muted hover:text-foreground aria-pressed:bg-primary aria-pressed:text-primary-foreground aria-pressed:shadow-sm aria-pressed:hover:bg-primary/90 disabled:opacity-30 disabled:cursor-default disabled:hover:bg-transparent disabled:hover:text-muted-foreground [app-region:no-drag]",
        className,
      )}
      aria-label={ariaLabel ?? tooltip}
      {...props}
      onMouseEnter={(event) => {
        if (tooltip) show(event.currentTarget);
        onMouseEnter?.(event);
      }}
      onMouseLeave={(event) => {
        hide();
        onMouseLeave?.(event);
      }}
      onMouseDown={(event) => {
        hide();
        onMouseDown?.(event);
      }}
      onFocus={(event) => {
        // Only keyboard focus reveals the tooltip; pointer focus is handled by hover.
        if (tooltip && event.currentTarget.matches(":focus-visible")) show(event.currentTarget);
        onFocus?.(event);
      }}
      onBlur={(event) => {
        hide();
        onBlur?.(event);
      }}
    >
      {children}
      {label && anchor && <TooltipBubble label={label} anchor={anchor} wrap={Boolean(binding)} />}
    </button>
  );
});

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  function IconButton(props, ref) {
    return <ObservedIconButton {...props} buttonRef={ref} />;
  },
);
