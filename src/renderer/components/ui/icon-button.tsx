import {
  createContext,
  forwardRef,
  useContext,
  useId,
  type ButtonHTMLAttributes,
  type ReactNode,
  type Ref,
} from "react";
import { observer } from "r-state-tree/react";
import type { CakeHotkeyActionId } from "../../../contracts/application/cake-settings-data";
import { formatHotkey } from "@/lib/hotkeys";
import { cn } from "@/lib/utils";
import { TooltipBubble, useTooltip } from "./tooltip";
import { NavigationRailLabelsContext } from "./navigation-rail-labels";
import { viewFocusHighlightClassName } from "./view-focus";
import { IconSizeProvider, useIconRole, type IconSize } from "./icon-size";

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
> & {
  /** Glyph role only; leaves the hit target unchanged. Inherits an inline scope. */
  iconSize?: IconSize;
  hotkey?: CakeHotkeyActionId;
  /** Visible navigation label; the containing rail controls its disclosure. */
  label?: ReactNode;
  pressedAppearance?: "solid" | "subtle";
  /** Persistent view focus, independent of pressed/open and keyboard focus. */
  viewFocused?: boolean;
  /** Wrap a long tooltip instead of truncating it, for labels whose full text matters. */
  wrapTooltip?: boolean;
} & ({ tooltip: string; ariaLabel?: string } | { tooltip?: undefined; ariaLabel: string });

/** Square transparent button for a single icon; tooltips show quickly by default. */
const ObservedIconButton = observer(function ObservedIconButton({
  tooltip,
  iconSize,
  hotkey,
  label: visibleLabel,
  ariaLabel,
  type = "button",
  className,
  pressedAppearance = "solid",
  viewFocused = false,
  wrapTooltip = false,
  children,
  onMouseEnter,
  onMouseLeave,
  onMouseDown,
  onFocus,
  onBlur,
  buttonRef,
  "aria-describedby": describedBy,
  ...props
}: IconButtonProps & { buttonRef?: Ref<HTMLButtonElement> }) {
  const inheritedIconSize = useIconRole();
  const railLabelsVisible = useContext(NavigationRailLabelsContext);
  const redundantTooltip = railLabelsVisible === true && visibleLabel !== undefined;
  const { anchor, hide, show } = useTooltip(!redundantTooltip);
  const hotkeyDescriptionId = useId();
  const bindingFor = useContext(HotkeyBindingsContext);
  const binding = hotkey && bindingFor?.(hotkey);
  const label = tooltip && binding ? `${tooltip} (${formatHotkey(binding)})` : tooltip;

  return (
    <button
      ref={buttonRef}
      type={type}
      className={cn(
        "icon-button grid shrink-0 touch-manipulation size-7 [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11 place-items-center rounded-md border-0 bg-transparent text-muted-foreground transition-colors hover:bg-muted/85 hover:text-foreground active:bg-muted disabled:opacity-30 disabled:cursor-default disabled:hover:bg-transparent disabled:hover:text-muted-foreground [app-region:no-drag]",
        visibleLabel !== undefined && "h-9 w-full grid-cols-[2.75rem_minmax(0,1fr)] gap-1",
        !viewFocused &&
          (pressedAppearance === "solid"
            ? "aria-pressed:bg-primary aria-pressed:text-primary-foreground aria-pressed:shadow-2xs aria-pressed:hover:bg-primary/90"
            : "aria-pressed:text-accent aria-pressed:hover:bg-accent/10"),
        viewFocused && viewFocusHighlightClassName,
        className,
      )}
      data-view-focused={viewFocused || undefined}
      aria-label={ariaLabel ?? tooltip}
      aria-describedby={
        [describedBy, redundantTooltip && binding ? hotkeyDescriptionId : undefined]
          .filter(Boolean)
          .join(" ") || undefined
      }
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
      <IconSizeProvider size={iconSize ?? inheritedIconSize ?? "navigation"}>
        {visibleLabel === undefined ? (
          children
        ) : (
          <>
            <span className="grid h-9 w-11 place-items-center">{children}</span>
            <span
              data-slot="icon-button-label"
              className={cn(
                "w-full min-w-0 truncate text-left text-xs",
                railLabelsVisible !== undefined && "font-semibold text-foreground",
              )}
            >
              {visibleLabel}
            </span>
          </>
        )}
      </IconSizeProvider>
      {redundantTooltip && binding && (
        <span id={hotkeyDescriptionId} className="sr-only">
          {formatHotkey(binding)}
        </span>
      )}
      {!redundantTooltip && label && anchor && (
        <TooltipBubble label={label} anchor={anchor} wrap={wrapTooltip || Boolean(binding)} />
      )}
    </button>
  );
});

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  function IconButton(props, ref) {
    return <ObservedIconButton {...props} buttonRef={ref} />;
  },
);
