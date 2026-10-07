import { cva, type VariantProps } from "class-variance-authority";
import { observer } from "r-state-tree/react";
import { useRef, useImperativeHandle, type Ref, type TextareaHTMLAttributes } from "react";
import { useDictationInput } from "../../dictation/use-dictation-input";
import { DictationIndicator } from "./dictation-indicator";
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
  ref?: Ref<HTMLTextAreaElement>;
}

export const Textarea = observer(function Textarea({
  ref,
  className,
  size,
  font,
  dictation = false,
  onFocus,
  onBlur,
  onChange,
  onSelect,
  onKeyDown,
  ...props
}: TextareaProps) {
  const input = useRef<HTMLTextAreaElement | null>(null);
  useImperativeHandle(ref, () => {
    if (!input.current) throw new Error("Textarea ref is not mounted");
    return input.current;
  });
  const voice = useDictationInput(dictation && !props.disabled && !props.readOnly, input);
  const active = voice.store?.enabled && voice.store.activeTargetId === voice.id;
  const field = (
    <textarea
      ref={input}
      className={cn(
        textareaVariants({ size, font }),
        className,
        // Indent only the first line; soft wraps and newlines keep the full writing width.
        active && "indent-8",
      )}
      {...props}
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
  // Keep the DOM shape stable when conversation mode temporarily owns this field.
  return (
    <div
      className="relative grid w-full min-w-0"
      data-slot={dictation ? "dictation-field" : "textarea-field"}
    >
      {field}
      {voice.store && <DictationIndicator store={voice.store} targetId={voice.id} anchor={input} />}
    </div>
  );
});
