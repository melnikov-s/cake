import type { CanvasCard, CanvasRevision } from "../contracts/project-canvas/project-canvas";

/** One exact match per card, favoring titles over matches inside notes or feedback. */
export function searchCanvas(cards: readonly CanvasCard[], query: string) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const hits: { card: CanvasCard; revision: CanvasRevision; score: number }[] = [];
  for (const card of cards) {
    let best: (typeof hits)[number] | undefined;
    for (const rev of card.revisions) {
      const title = rev.title.toLowerCase();
      const haystack = [
        card.group,
        rev.title,
        rev.content.kind === "decision" ? rev.content.text : "",
        ...rev.pins.map((pin) => pin.text),
      ]
        .join(" ")
        .toLowerCase();
      if (!words.every((word) => haystack.includes(word))) continue;
      const score = words.filter((word) => title.includes(word)).length;
      if (!best || score >= best.score) best = { card, revision: rev, score };
    }
    if (best) hits.push(best);
  }
  return hits.sort((a, b) => b.score - a.score || b.revision.at.localeCompare(a.revision.at));
}
