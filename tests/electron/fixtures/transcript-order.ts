import type { Locator } from "@playwright/test";

/**
 * Picks the first or last match in transcript display order. Since fc455223 the virtualized
 * transcript (LegendList) does not keep rows in DOM order, so `.first()`/`.last()` on rows or
 * their contents can select an arbitrary item. Rows carry `data-transcript-item-index`.
 */
export async function inDisplayOrder(matches: Locator, which: "first" | "last"): Promise<Locator> {
  await matches.first().waitFor({ state: "attached" });
  const indexes = await matches.evaluateAll((elements) =>
    elements.map((element) => {
      const row = element.closest<HTMLElement>("[data-transcript-item-index]");
      return row ? Number(row.dataset.transcriptItemIndex) : Number.NaN;
    }),
  );
  let chosen = 0;
  for (let index = 1; index < indexes.length; index++) {
    const candidate = indexes[index]!;
    const current = indexes[chosen]!;
    if (which === "first" ? candidate < current : candidate >= current) chosen = index;
  }
  return matches.nth(chosen);
}
