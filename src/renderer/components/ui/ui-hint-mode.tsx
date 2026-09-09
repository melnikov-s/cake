import { useEffect, useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";
import { observer } from "r-state-tree/react";
import type { UiHintModeStore } from "@/stores/UiHintModeStore";

const targetSelector = [
  "button:not([disabled])",
  "a[href]",
  "input:not([disabled]):not([type='hidden'])",
  "textarea:not([disabled])",
  "select:not([disabled])",
  "summary",
  "[contenteditable='true']",
  "[role='button']:not([aria-disabled='true'])",
  "[role='link']:not([aria-disabled='true'])",
  "[tabindex]:not([tabindex='-1']):not([aria-disabled='true'])",
].join(",");

const hintAlphabet = "asdfghjklqwertyuiopzxcvbnm";
const highlightedTargetClasses = [
  "!opacity-100",
  "!visible",
  "outline-2",
  "outline-ring",
  "outline-offset-1",
] as const;

interface HintTarget {
  readonly element: HTMLElement;
  readonly label: string;
  readonly name: string;
  readonly rect: DOMRect;
}

function isVisibleTarget(element: HTMLElement) {
  if (!element.isConnected || element.closest("[aria-hidden='true'], [inert]")) return false;
  const style = window.getComputedStyle(element);
  if (style.display === "none" || style.visibility === "hidden") return false;
  const rect = element.getBoundingClientRect();
  return (
    rect.width > 0 &&
    rect.height > 0 &&
    rect.right > 0 &&
    rect.bottom > 0 &&
    rect.left < window.innerWidth &&
    rect.top < window.innerHeight
  );
}

function targetName(element: HTMLElement) {
  return (
    element.getAttribute("aria-label") ??
    element.getAttribute("title") ??
    element.getAttribute("placeholder") ??
    element.textContent?.trim().replace(/\s+/g, " ").slice(0, 80) ??
    element.tagName.toLowerCase()
  );
}

function labelFor(index: number, length: number) {
  let remaining = index;
  let label = "";
  for (let position = 0; position < length; position += 1) {
    label = hintAlphabet[remaining % hintAlphabet.length] + label;
    remaining = Math.floor(remaining / hintAlphabet.length);
  }
  return label;
}

function collectTargets(): HintTarget[] {
  const dialogs = [
    ...document.querySelectorAll<HTMLElement>("[role='dialog'], [role='alertdialog']"),
  ]
    .filter(isVisibleTarget)
    .filter((dialog) => !dialog.closest('[data-slot="ui-hint-overlay"]'));
  const scope = dialogs.at(-1) ?? document.body;
  const elements = [...scope.querySelectorAll<HTMLElement>(targetSelector)]
    .filter((element) => !element.closest('[data-slot="ui-hint-overlay"]'))
    .filter(isVisibleTarget)
    .filter((element) => {
      const parentTarget = element.parentElement?.closest<HTMLElement>(targetSelector);
      return !parentTarget || !scope.contains(parentTarget);
    })
    .sort((left, right) => {
      const leftRect = left.getBoundingClientRect();
      const rightRect = right.getBoundingClientRect();
      return leftRect.top - rightRect.top || leftRect.left - rightRect.left;
    });
  const labelLength = Math.max(
    1,
    Math.ceil(Math.log(elements.length) / Math.log(hintAlphabet.length)),
  );
  return elements.map((element, index) => ({
    element,
    label: labelFor(index, labelLength),
    name: targetName(element),
    rect: element.getBoundingClientRect(),
  }));
}

function naturallyActivate(element: HTMLElement) {
  if (
    element.matches(
      "textarea, select, [contenteditable='true'], input:not([type='button']):not([type='submit']):not([type='reset']):not([type='checkbox']):not([type='radio'])",
    )
  ) {
    element.focus();
    return;
  }
  element.click();
}

export const UiHintMode = observer(function UiHintMode({ store }: { store: UiHintModeStore }) {
  const [targets, setTargets] = useState<HintTarget[]>([]);

  useLayoutEffect(() => {
    if (!store.active) {
      setTargets([]);
      return;
    }
    setTargets(collectTargets());
  }, [store.active]);

  useLayoutEffect(() => {
    if (!store.active) return;
    const restorations = targets.map(({ element, label }) => {
      const addedClasses = highlightedTargetClasses.filter((className) =>
        element.classList.contains(className) ? false : (element.classList.add(className), true),
      );
      const previousTarget = element.getAttribute("data-cake-hint-target");
      const previousLabel = element.getAttribute("data-cake-hint-label");
      element.setAttribute("data-cake-hint-target", "true");
      element.setAttribute("data-cake-hint-label", label);
      return () => {
        for (const className of addedClasses) element.classList.remove(className);
        if (previousTarget === null) element.removeAttribute("data-cake-hint-target");
        else element.setAttribute("data-cake-hint-target", previousTarget);
        if (previousLabel === null) element.removeAttribute("data-cake-hint-label");
        else element.setAttribute("data-cake-hint-label", previousLabel);
      };
    });
    return () => restorations.forEach((restore) => restore());
  }, [store.active, targets]);

  useEffect(() => {
    if (!store.active) return;
    const reposition = () => {
      setTargets((current) =>
        current
          .filter(({ element }) => isVisibleTarget(element))
          .map((target) => ({ ...target, rect: target.element.getBoundingClientRect() })),
      );
    };
    document.addEventListener("scroll", reposition, true);
    window.addEventListener("resize", reposition);
    return () => {
      document.removeEventListener("scroll", reposition, true);
      window.removeEventListener("resize", reposition);
    };
  }, [store.active]);

  useEffect(() => {
    if (!store.active) return;
    const keydown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        store.close();
        return;
      }
      if (event.key === "Backspace") {
        event.preventDefault();
        event.stopImmediatePropagation();
        store.removeLast();
        return;
      }
      if (!/^[a-z]$/i.test(event.key)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const prefix = `${store.prefix}${event.key.toLowerCase()}`;
      const candidates = targets.filter(({ label }) => label.startsWith(prefix));
      const exact = candidates.find(({ label }) => label === prefix);
      if (exact) {
        store.close();
        naturallyActivate(exact.element);
      } else if (candidates.length > 0) store.append(event.key);
      else store.close();
    };
    window.addEventListener("keydown", keydown, { capture: true });
    return () => window.removeEventListener("keydown", keydown, { capture: true });
  }, [store, store.active, store.prefix, targets]);

  if (!store.active || !("document" in globalThis)) return null;
  const matchingTargets = targets.filter(({ label }) => label.startsWith(store.prefix));
  return createPortal(
    <div
      data-slot="ui-hint-overlay"
      className="pointer-events-none fixed inset-0 z-[100] overflow-hidden"
      aria-label="UI hint mode"
    >
      <p className="sr-only" aria-live="polite">
        {matchingTargets.length} targets. Type a displayed key to activate a control, or Escape to
        cancel.
      </p>
      {matchingTargets.map(({ element, label, name, rect }) => (
        <kbd
          key={label}
          data-slot="ui-hint"
          data-hint-label={label}
          aria-label={`${name}: ${label.toUpperCase()}`}
          className="absolute grid min-w-4 -translate-x-1/3 -translate-y-1/3 place-items-center rounded border border-background bg-accent px-1 py-0.5 font-mono text-[10px] font-bold leading-none tracking-tight text-accent-foreground shadow-md"
          style={{
            left: Math.max(8, Math.min(window.innerWidth - 8, rect.left)),
            top: Math.max(8, Math.min(window.innerHeight - 8, rect.top)),
          }}
        >
          {label.toUpperCase()}
          <span className="sr-only"> for {targetName(element)}</span>
        </kbd>
      ))}
    </div>,
    document.body,
  );
});
