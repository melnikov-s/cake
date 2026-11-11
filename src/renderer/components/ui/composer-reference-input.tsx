import {
  useContext,
  useLayoutEffect,
  useRef,
  useImperativeHandle,
  type Ref,
  type HTMLAttributes,
} from "react";
import type { SessionPurpose } from "../../../contracts/project-sessions/session-purpose";
import { modelReferenceLabel } from "../../../contracts/model-presets/model-reference";
import {
  splitComposerReferences,
  type ComposerReferenceSegment,
} from "../../lib/composer-references";
import { modelChipClassName } from "../model-picker";
import { buttonVariants } from "./button";
import { ChevronDownIcon, LinkIcon, UserIcon, BotIcon } from "./icons";
import type { ComposerInputElement } from "../../lib/composer-input-element";
import { modelReferenceChipClassName } from "./model-reference-chip";
import { cn } from "../../lib/utils";
import { useDictationInput } from "../../dictation/use-dictation-input";
import { applyInputEdit } from "../../lib/input-edit";
import { DictationIndicatorContext } from "../../dictation/dictation-indicator-context";
import { DictationIndicator } from "./dictation-indicator";
import { createPortal } from "react-dom";

function nodeText(node: Node): string {
  if (node instanceof HTMLElement && node.dataset.composerReference)
    return node.dataset.composerReference;
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
export function ComposerReferenceInput({
  value,
  onValueChange,
  onEditReference,
  sessionReferenceNames,
  sessionReferencePurposes,
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
  onEditReference(segment: ComposerReferenceSegment, anchor: HTMLElement): void;
  sessionReferenceNames?: ReadonlyMap<string, string>;
  sessionReferencePurposes?: ReadonlyMap<string, SessionPurpose>;
  onCursorChange?(cursor: number): void;
  inputRef: Ref<ComposerInputElement>;
  placeholder?: string;
}) {
  const element = useRef<HTMLDivElement & ComposerInputElement>(null);
  const sessionIcons = useRef<HTMLSpanElement>(null);
  const sessionName = (id: string) => sessionReferenceNames?.get(id) || id;
  const updateSessionChip = (chip: HTMLElement) => {
    const id = chip.dataset.sessionId!;
    const name = sessionName(id);
    chip.querySelector("[data-session-name]")!.textContent = name;
    const purpose = sessionReferencePurposes?.get(id);
    const label =
      purpose === "user"
        ? "User Session"
        : purpose === "delegated"
          ? "Delegated Session"
          : undefined;
    const icon =
      sessionIcons.current?.children[purpose === "user" ? 2 : purpose === "delegated" ? 3 : 0];
    if (icon) chip.firstElementChild?.replaceWith(icon.cloneNode(true));
    chip.title = [name, label, id].filter(Boolean).join("\n");
    chip.setAttribute("aria-label", `Edit session reference: ${name}`);
    if (label) chip.setAttribute("aria-description", label);
    else chip.removeAttribute("aria-description");
  };
  const textInput = useRef<ComposerInputElement | null>(null);
  const voice = useDictationInput(dictation, textInput, dictationSubmit);
  const indicatorDestination = useContext(DictationIndicatorContext);
  const active = voice.store?.enabled && voice.store.activeTargetId === voice.id;
  const change = useRef(onValueChange);
  change.current = onValueChange;
  const render = (root: HTMLElement, text: string) => {
    root.replaceChildren(
      ...splitComposerReferences(text).map((segment) => {
        if (!segment.model && !segment.sessionId) return document.createTextNode(segment.text);
        const chip = document.createElement("button");
        chip.type = "button";
        chip.contentEditable = "false";
        chip.dataset.composerReference = segment.text;
        if (segment.sessionId) {
          chip.dataset.slot = "session-reference";
          chip.dataset.sessionId = segment.sessionId;
          chip.className = cn(
            buttonVariants({ variant: "ghost", size: "sm" }),
            modelChipClassName,
            "align-baseline hover:bg-muted/70 hover:text-foreground transition-colors",
          );
          // Clone the shared icon catalog, rather than defining editor-local SVGs.
          const icons = sessionIcons.current!;
          const name = document.createElement("span");
          name.dataset.sessionName = "";
          name.className = "truncate font-semibold";
          chip.append(icons.children[0]!.cloneNode(true), name, icons.children[1]!.cloneNode(true));
          chip.setAttribute("aria-haspopup", "dialog");
          updateSessionChip(chip);
        } else if (segment.model) {
          chip.dataset.slot = "model-reference";
          chip.className = modelReferenceChipClassName;
          chip.textContent = modelReferenceLabel(segment.model);
          chip.title = `${segment.model.provider}/${segment.model.modelId}`;
          chip.setAttribute("aria-label", `Edit model reference: ${chip.textContent}`);
        }
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
  useLayoutEffect(() => {
    element.current
      ?.querySelectorAll<HTMLElement>('[data-slot="session-reference"]')
      .forEach(updateSessionChip);
  }, [sessionReferenceNames, sessionReferencePurposes]);
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
    applyInputEdit(root, {
      value: current.slice(0, start) + text + current.slice(end),
      start: start + text.length,
      end: start + text.length,
    });
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
      <span ref={sessionIcons} hidden aria-hidden="true">
        <LinkIcon className="size-3 shrink-0 text-muted-foreground" />
        <span className="shrink-0 text-muted-foreground">
          <ChevronDownIcon size={12} />
        </span>
        <span className="text-muted-foreground [&>svg]:size-3">
          <UserIcon />
        </span>
        <span className="text-muted-foreground [&>svg]:size-3">
          <BotIcon />
        </span>
      </span>
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
              ? event.target.closest<HTMLElement>("[data-composer-reference]")
              : null;
          if (!target) return;
          const start = offsetAt(
            element.current!,
            target.parentNode!,
            Array.from(target.parentNode!.childNodes).indexOf(target),
          );
          const segment = splitComposerReferences(nodeText(element.current!)).find(
            (part) => part.start === start && (part.model || part.sessionId),
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
