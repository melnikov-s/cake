// Row packing and world metrics adapted from Rounds (MIT); see ../../public/ROUNDS-LICENSE.txt.
import type { CanvasCard, CanvasRevision } from "../../../contracts/project-canvas/project-canvas";

export type Tile = {
  card: CanvasCard;
  revision: CanvasRevision;
  x: number;
  y: number;
  w: number;
  h: number;
};
type ReviewGroup = {
  name: string;
  at: string;
  x: number;
  y: number;
  w: number;
  h: number;
  tiles: Tile[];
};
const ROW_H = 260,
  ITEM_GAP = 20,
  MAX_ROW_W = 1760,
  TITLE_H = 44,
  GROUP_GAP = 88,
  HEAD = 184;

export function layoutCanvas(cards: readonly CanvasCard[]) {
  const byName = new Map<string, CanvasCard[]>();
  for (const card of cards) {
    const group = byName.get(card.group);
    if (group) group.push(card);
    else byName.set(card.group, [card]);
  }
  const named = [...byName]
    .map(([name, members]) => ({
      name,
      members,
      at: members.reduce((max, card) => {
        const at = card.revisions.at(-1)?.at ?? "";
        return at > max ? at : max;
      }, ""),
    }))
    .sort((a, b) => b.at.localeCompare(a.at));
  let y = HEAD,
    w = 720;
  const groups: ReviewGroup[] = named.map(({ name, members, at }) => {
    let x = 0,
      row = y + TITLE_H,
      width = 0;
    const tiles: Tile[] = [];
    for (const card of members) {
      const revision = card.revisions.at(-1) ?? card.revisions[0];
      const tileWidth = Math.round(Math.min(ROW_H * revision.aspect, MAX_ROW_W));
      if (x > 0 && x + tileWidth > MAX_ROW_W) {
        x = 0;
        row += ROW_H + ITEM_GAP;
      }
      tiles.push({ card, revision, x, y: row, w: tileWidth, h: ROW_H });
      width = Math.max(width, x + tileWidth);
      x += tileWidth + ITEM_GAP;
    }
    const h = row - y + ROW_H;
    const group = { name, at, x: 0, y, w: width, h, tiles };
    y += h + GROUP_GAP;
    w = Math.max(w, width);
    return group;
  });
  return { groups, rect: { x: 0, y: 0, w, h: Math.max(HEAD, y - GROUP_GAP) } };
}
