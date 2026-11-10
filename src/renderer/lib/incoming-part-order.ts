import type { UiPart } from "../../contracts/conversations/session-contract";

export interface IncomingPartAnchor {
  id: string;
  after?: string;
}

const key = (part: UiPart) => (part.kind === "text" ? (part.renderKey ?? part.id) : part.id);
const visible = (part: UiPart) =>
  part.kind !== "text" || (part.deliveryState !== "queued" && part.deliveryState !== "steering");

/** Window-local layout metadata only, never another transcript. Promotion keeps its position. */
export function incomingPartAnchors(
  parts: readonly UiPart[],
  previous: readonly IncomingPartAnchor[],
): IncomingPartAnchor[] {
  const ids = new Set(parts.map(key));
  const anchors = previous.filter((anchor) => ids.has(anchor.id));
  const known = new Set(anchors.map((anchor) => anchor.id));
  let after: string | undefined;
  for (const part of parts) {
    const id = key(part);
    if (part.pendingIncoming && !known.has(id)) {
      anchors.push({ id, after });
      known.add(id);
    }
    if (visible(part)) after = id;
  }
  return anchors;
}

export function orderIncomingParts(
  parts: readonly UiPart[],
  anchors: readonly IncomingPartAnchor[],
): UiPart[] {
  const result = [...parts];
  for (const anchor of anchors) {
    const index = result.findIndex((part) => key(part) === anchor.id);
    const target =
      anchor.after === undefined ? -1 : result.findIndex((part) => key(part) === anchor.after);
    if (index < 0 || (anchor.after !== undefined && target < 0)) continue;
    const [part] = result.splice(index, 1);
    if (part) result.splice(target + (index > target ? 1 : 0), 0, part);
  }
  return result;
}
