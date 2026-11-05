import {
  useContext,
  useLayoutEffect,
  useRef,
  useImperativeHandle,
  type Ref,
  type HTMLAttributes,
} from "react";
import {
  modelReferenceLabel,
  splitModelReferences,
} from "../../../contracts/model-presets/model-reference";
import type { ModelReferenceSegment } from "../../../contracts/model-presets/model-reference";
import type { ComposerInputElement } from "../../lib/composer-input-element";
import { modelReferenceChipClassName } from "./model-reference-chip";
import { cn } from "../../lib/utils";
import { useDictationInput } from "../../dictation/use-dictation-input";
import { DictationIndicatorContext } from "../../dictation/dictation-indicator-context";
import { DictationIndicator } from "./dictation-indicator";
import { createPortal } from "react-dom";

function nodeText(node: Node): string {
  if (node instanceof HTMLElement && node.dataset.modelReference)
    return node.dataset.modelReference;
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
  if (node.nodeName === "BR") return "\n";
  return Array.from(node.childNodes, nodeText).join("");
}

function offsetAt(root: Node, node: Node, offset: number): number {
  if (root === node)
    return node.nodeType === Node.TEXT_NODE
      ? offset
      : Array.from(node.childNodes)
          .slice(0, offset)
          .reduce((sum, child) => sum + nodeText(child).length, 0);
  let result = 0;
  for (const child of root.childNodes) {
    if (child === node || child.contains(node)) return result + offsetAt(child, node, offset);
    result += nodeText(child).length;
  }
  return result;
}

function selection(root: HTMLElement): [number, number] {
  const current = window.getSelection();
  if (
    !current?.rangeCount ||
    !root.contains(current.anchorNode) ||
    !root.contains(current.focusNode)
  )
    return [nodeText(root).length, nodeText(root).length];
  const range = current.getRangeAt(0);
  return [
    offsetAt(root, range.startContainer, range.startOffset),
    offsetAt(root, range.endContainer, range.endOffset),
  ];
}

function setSelection(root: HTMLElement, start: number, end: number) {
  const point = (offset: number): [Node, number] => {
    let remaining = offset;
    for (let index = 0; index < root.childNodes.length; index++) {
      const child = root.childNodes[index]!;
      const length = nodeText(child).length;
      if (remaining <= length) {
        if (child.nodeType === Node.TEXT_NODE) return [child, remaining];
        return [root, index + (remaining > 0 ? 1 : 0)];
      }
      remaining -= length;
    }
    return [root, root.childNodes.length];
  };
  const range = document.createRange();
  range.setStart(...point(start));
  range.setEnd(...point(end));
  const current = window.getSelection();
  current?.removeAllRanges();
  current?.addRange(range);
}

/** Small atomic-token editor. The authoritative value remains ordinary message text. */
export function ModelReferenceInput({
  value,
  onValueChange,
  onEditReference,
  onCursorChange,
  inputRef,
  placeholder,
  className,
  onKeyDown,
  onPaste,
  dictation = true,
  dictationSubmit,
  onFocus,
  onBlur,
  ...props
}: Omit<HTMLAttributes<HTMLDivElement>, "onChange"> & {
  value: string;
  dictation?: boolean;
  dictationSubmit?: () => void | Promise<void>;
  onValueChange(value: string, cursor: number): void;
  onEditReference(segment: ModelReferenceSegment, anchor: HTMLElement): void;
  onCursorChange?(cursor: number): void;
  inputRef: Ref<ComposerInputElement>;
  placeholder?: string;
}) {
  const element = useRef<HTMLDivElement & ComposerInputElement>(null);
  const textInput = useRef<ComposerInputElement | null>(null);
  const voice = useDictationInput(dictation, textInput, dictationSubmit);
  const indicatorDestination = useContext(DictationIndicatorContext);
  const active = voice.store?.enabled && voice.store.activeTargetId === voice.id;
  const change = useRef(onValueChange);
  change.current = onValueChange;
  const render = (root: HTMLElement, text: string) => {
    root.replaceChildren(
      ...splitModelReferences(text).map((segment) => {
        if (!segment.model) return document.createTextNode(segment.text);
        const chip = document.createElement("button");
        chip.type = "button";
        chip.dataset.slot = "model-reference";
        chip.contentEditable = "false";
        chip.dataset.modelReference = segment.text;
        chip.className = modelReferenceChipClassName;
        chip.textContent = modelReferenceLabel(segment.model);
        chip.title = `${segment.model.provider}/${segment.model.modelId}`;
        chip.setAttribute("aria-label", `Edit model reference: ${chip.textContent}`);
        return chip;
      }),
    );
  };
  useImperativeHandle(inputRef, () => {
    const root = element.current!;
    Object.defineProperties(root, {
      value: {
        configurable: true,
        get: () => nodeText(root),
        set: (next: string) => render(root, next),
      },
      selectionStart: { configurable: true, get: () => selection(root)[0] },
      selectionEnd: { configurable: true, get: () => selection(root)[1] },
      disabled: { configurable: true, get: () => false },
      readOnly: { configurable: true, get: () => false },
      setSelectionRange: {
        configurable: true,
        value: (start: number, end: number) => setSelection(root, start, end),
      },
    });
    textInput.current = root;
    return textInput.current;
  });
  useLayoutEffect(() => {
    const root = element.current!;
    if (nodeText(root) === value) return;
    const focused = document.activeElement === root;
    const [start, end] = selection(root);
    render(root, value);
    if (focused) setSelection(root, Math.min(start, value.length), Math.min(end, value.length));
  }, [value]);
  const publish = () => {
    const root = element.current!;
    const text = nodeText(root);
    const [start] = selection(root);
    change.current(text, start);
    voice.onChange();
  };
  const insert = (text: string) => {
    const root = element.current!;
    const [start, end] = selection(root);
    const current = nodeText(root);
    render(root, current.slice(0, start) + text + current.slice(end));
    setSelection(root, start + text.length, start + text.length);
    publish();
  };
  const indicator = voice.store && (
    <DictationIndicator
      store={voice.store}
      targetId={voice.id}
      anchor={textInput}
      inline={indicatorDestination === undefined}
    />
  );
  return (
    <>
      <div
        {...props}
        ref={element}
        contentEditable
        suppressContentEditableWarning
        role="combobox"
        aria-multiline="true"
        data-placeholder={placeholder}
        className={cn(
          "min-h-10 max-h-80 w-full overflow-y-auto whitespace-pre-wrap break-words px-2 py-2 text-sm leading-6 outline-none empty:before:text-muted-foreground empty:before:content-[attr(data-placeholder)]",
          active && indicatorDestination === undefined && "indent-8",
          className,
        )}
        onInput={publish}
        onFocus={(event) => {
          onFocus?.(event);
          if (event.target === event.currentTarget) voice.onFocus();
        }}
        onBlur={(event) => {
          voice.onBlur(event.relatedTarget);
          onBlur?.(event);
        }}
        onSelect={() => {
          voice.onSelect();
          onCursorChange?.(selection(element.current!)[0]);
        }}
        onClick={(event) => {
          const target =
            event.target instanceof HTMLElement
              ? event.target.closest<HTMLElement>("[data-model-reference]")
              : null;
          if (!target) return;
          const start = offsetAt(
            element.current!,
            target.parentNode!,
            Array.from(target.parentNode!.childNodes).indexOf(target),
          );
          const segment = splitModelReferences(nodeText(element.current!)).find(
            (part) => part.start === start && part.model,
          );
          if (segment) onEditReference(segment, target);
        }}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return;
          if (voice.onKeyDown(event, Boolean(onKeyDown))) return;
          onKeyDown?.(event);
          if (!event.defaultPrevented && event.key === "Enter" && !event.nativeEvent.isComposing) {
            event.preventDefault();
            insert("\n");
          }
        }}
        onPaste={(event) => {
          onPaste?.(event);
          if (!event.defaultPrevented) {
            event.preventDefault();
            insert(event.clipboardData.getData("text/plain"));
          }
        }}
        onCopy={(event) => {
          const [start, end] = selection(element.current!);
          event.clipboardData.setData("text/plain", nodeText(element.current!).slice(start, end));
          event.preventDefault();
        }}
        onCut={(event) => {
          const [start, end] = selection(element.current!);
          event.clipboardData.setData("text/plain", nodeText(element.current!).slice(start, end));
          event.preventDefault();
          insert("");
        }}
      />
      {indicatorDestination === undefined
        ? indicator
        : indicatorDestination && createPortal(indicator, indicatorDestination)}
    </>
  );
}
