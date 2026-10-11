import { cva, type VariantProps } from "class-variance-authority";
import { observer } from "r-state-tree/react";
import {
  useContext,
  useRef,
  useImperativeHandle,
  type Ref,
  type TextareaHTMLAttributes,
} from "react";
import { createPortal } from "react-dom";
import { DictationIndicatorContext } from "../../dictation/dictation-indicator-context";
import { useDictationInput } from "../../dictation/use-dictation-input";
import { DictationIndicator } from "./dictation-indicator";
import { TextareaProvisionalText } from "./textarea-provisional-text";
import type { ProvisionalTextSpan } from "../../dictation/provisional-text";
import { cn } from "@/lib/utils";

const textareaVariants = cva(
  "flex w-full min-w-0 rounded-lg border border-border bg-background text-foreground transition-colors placeholder:text-muted-foreground outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/25 disabled:cursor-not-allowed disabled:opacity-50",
  {
    variants: {
      size: {
        default: "p-2.5 text-xs leading-relaxed",
        sm: "p-2 text-[11px] leading-relaxed",
        lg: "p-3 text-sm leading-relaxed",
      },
      font: {
        sans: "font-sans",
        mono: "font-mono text-[12px] leading-[1.45]",
      },
    },
    defaultVariants: {
      size: "default",
      font: "sans",
    },
  },
);

export interface TextareaProps
  extends TextareaHTMLAttributes<HTMLTextAreaElement>, VariantProps<typeof textareaVariants> {
  /** Opt in only Cake-owned prose fields; never code, paths or embedded surfaces. */
  dictation?: boolean;
  /** Optional voice-mode span; dictation supplies its own through the registered target. */
  provisionalText?: ProvisionalTextSpan;
  ref?: Ref<HTMLTextAreaElement>;
  /** Non-editable focus destination; native forward Tab enters the textarea. */
  focusAnchorRef?: Ref<HTMLDivElement>;
}

export const Textarea = observer(function Textarea({
  ref,
  className,
  size,
  font,
  dictation = false,
  provisionalText,
  focusAnchorRef,
  onFocus,
  onBlur,
  onChange,
  onSelect,
  onKeyDown,
  ...props
}: TextareaProps) {
  const indicatorDestination = useContext(DictationIndicatorContext);
  const inlineIndicator = indicatorDestination === undefined;
  const input = useRef<HTMLTextAreaElement | null>(null);
  useImperativeHandle(ref, () => {
    if (!input.current) throw new Error("Textarea ref is not mounted");
    return input.current;
  });
  const voice = useDictationInput(dictation && !props.disabled && !props.readOnly, input);
  const active = voice.store?.enabled && voice.store.activeTargetId === voice.id;
  const candidate = provisionalText ?? (active ? voice.store?.provisionalText : undefined);
  const pending =
    candidate &&
    candidate.value === props.value &&
    candidate.start >= 0 &&
    candidate.end > candidate.start &&
    candidate.end <= candidate.value.length
      ? candidate
      : undefined;
  const presentation = cn(
    textareaVariants({ size, font }),
    className,
    // Keep the first-line inset stable through preparation, listening and finishing.
    active && inlineIndicator && "indent-8",
  );
  const field = (
    <textarea
      ref={input}
      className={cn(presentation, pending && "text-transparent caret-foreground")}
      {...props}
      aria-description={
        pending
          ? [props["aria-description"], "Dictated text is provisional until cleanup finishes."]
              .filter(Boolean)
              .join(" ")
          : props["aria-description"]
      }
      onFocus={(event) => {
        onFocus?.(event);
        voice.onFocus();
      }}
      onBlur={(event) => {
        voice.onBlur(event);
        onBlur?.(event);
      }}
      onChange={(event) => {
        onChange?.(event);
        voice.onChange();
      }}
      onSelect={(event) => {
        voice.onSelect();
        onSelect?.(event);
      }}
      onKeyDown={(event) => {
        if (!voice.onKeyDown(event, !!onKeyDown)) onKeyDown?.(event);
      }}
    />
  );
  const indicator = voice.store && (
    <DictationIndicator
      store={voice.store}
      targetId={voice.id}
      anchor={input}
      inline={inlineIndicator}
    />
  );
  // Keep the DOM shape stable when conversation mode temporarily owns this field.
  return (
    <div
      ref={focusAnchorRef}
      tabIndex={focusAnchorRef ? -1 : undefined}
      role={focusAnchorRef ? "group" : undefined}
      aria-label={focusAnchorRef ? "Press Tab to write" : undefined}
      className="relative grid w-full min-w-0 outline-none"
      data-slot={dictation ? "dictation-field" : "textarea-field"}
    >
      {field}
      {pending && (
        <TextareaProvisionalText anchor={input} span={pending} className={presentation} />
      )}
      {inlineIndicator
        ? indicator
        : indicatorDestination && createPortal(indicator, indicatorDestination)}
    </div>
  );
});
