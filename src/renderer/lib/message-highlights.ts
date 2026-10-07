import { useLayoutEffect, type RefObject } from "react";

export interface MessageHighlightAnchor {
  startOffset?: number;
  endOffset?: number;
}

// Each mounted content surface owns its ranges, including simultaneous transcript
// and fullscreen renderings of the same message.
const messageHighlightRanges = new Map<symbol, Range[]>();
type HighlightValue = { readonly priority?: number };
type HighlightRegistry = {
  set(name: string, value: HighlightValue): void;
  delete(name: string): void;
};
type HighlightConstructor = new (...ranges: Range[]) => HighlightValue;

function refreshMessageHighlights() {
  // SAFETY: the experimental CSS Highlight API is feature-detected before use.
  const registry = (
    globalThis.CSS as (typeof globalThis.CSS & { highlights?: HighlightRegistry }) | undefined
  )?.highlights;
  // SAFETY: only DOM Range instances are passed to the guarded constructor.
  const HighlightClass = (globalThis as typeof globalThis & { Highlight?: HighlightConstructor })
    .Highlight;
  if (!registry || !HighlightClass) return;
  const ranges = [...messageHighlightRanges.values()].flat();
  if (ranges.length === 0) registry.delete("cake-message-comment");
  else registry.set("cake-message-comment", new HighlightClass(...ranges));
}

export function rangeAtOffsets(container: Node, start: number, end: number) {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let traversed = 0;
  let startPoint: { node: Node; offset: number } | undefined;
  let endPoint: { node: Node; offset: number } | undefined;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const length = node.textContent?.length ?? 0;
    if (!startPoint && start <= traversed + length)
      startPoint = { node, offset: Math.max(0, start - traversed) };
    if (end <= traversed + length) {
      endPoint = { node, offset: Math.max(0, end - traversed) };
      break;
    }
    traversed += length;
  }
  if (!startPoint || !endPoint) return undefined;
  const range = document.createRange();
  range.setStart(startPoint.node, startPoint.offset);
  range.setEnd(endPoint.node, endPoint.offset);
  return range;
}

export function useMessageHighlights(
  contentRef: RefObject<HTMLElement | null>,
  anchors: readonly MessageHighlightAnchor[],
  text: string,
) {
  useLayoutEffect(() => {
    const container = contentRef.current;
    if (!container || anchors.length === 0) return;
    const key = Symbol();
    const update = () => {
      messageHighlightRanges.set(
        key,
        anchors.flatMap(({ startOffset, endOffset }) => {
          if (startOffset === undefined || endOffset === undefined) return [];
          const range = rangeAtOffsets(container, startOffset, endOffset);
          return range ? [range] : [];
        }),
      );
      refreshMessageHighlights();
    };
    update();
    // Streamdown replaces fenced-code text nodes after asynchronous highlighting.
    const observer = new MutationObserver(update);
    observer.observe(container, { childList: true, characterData: true, subtree: true });
    return () => {
      observer.disconnect();
      messageHighlightRanges.delete(key);
      refreshMessageHighlights();
    };
  }, [contentRef, anchors, text]);
}
