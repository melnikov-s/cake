export interface NormalizedSourceSelection {
  startIndex: number;
  endIndex: number;
  selectedText: string;
  startColumn?: number;
  endColumn?: number;
}

function elementForNode(node: Node | null) {
  return node instanceof HTMLElement ? node : node?.parentElement ?? null;
}

export function selectionColumn(codeElement: HTMLElement, node: Node, offset: number) {
  const range = document.createRange();
  range.selectNodeContents(codeElement);
  try { range.setEnd(node, offset); }
  catch { return undefined; }
  const prefixLength = codeElement.querySelector<HTMLElement>("[data-review-prefix]")?.textContent?.length ?? 0;
  return Math.max(0, range.toString().length - prefixLength);
}

/** Converts a browser selection inside indexed source rows into ordered endpoints. */
export function extractSourceSelection(container: HTMLElement, rowSelector: string, indexAttribute: string): NormalizedSourceSelection | undefined {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0 || !selection.anchorNode || !selection.focusNode) return undefined;
  const anchorRow = elementForNode(selection.anchorNode)?.closest<HTMLElement>(rowSelector);
  const focusRow = elementForNode(selection.focusNode)?.closest<HTMLElement>(rowSelector);
  if (!anchorRow || !focusRow || !container.contains(anchorRow) || !container.contains(focusRow)) return undefined;
  const anchorIndex = Number(anchorRow.getAttribute(indexAttribute));
  const focusIndex = Number(focusRow.getAttribute(indexAttribute));
  if (!Number.isInteger(anchorIndex) || !Number.isInteger(focusIndex)) return undefined;
  const forward = anchorIndex < focusIndex || (anchorIndex === focusIndex && selection.anchorOffset <= selection.focusOffset);
  const startNode = forward ? selection.anchorNode : selection.focusNode;
  const endNode = forward ? selection.focusNode : selection.anchorNode;
  const startCode = elementForNode(startNode)?.closest<HTMLElement>("code");
  const endCode = elementForNode(endNode)?.closest<HTMLElement>("code");
  if (!startCode || !endCode) return undefined;
  return {
    startIndex: Math.min(anchorIndex, focusIndex),
    endIndex: Math.max(anchorIndex, focusIndex),
    selectedText: selection.toString(),
    startColumn: selectionColumn(startCode, startNode, forward ? selection.anchorOffset : selection.focusOffset),
    endColumn: selectionColumn(endCode, endNode, forward ? selection.focusOffset : selection.anchorOffset)
  };
}
