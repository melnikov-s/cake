import type { Locator } from "@playwright/test";

/**
 * Picks the first or last match in transcript display order. Since fc455223 the virtualized
 * transcript (LegendList) does not keep rows in DOM order, so `.first()`/`.last()` on rows or
 * their contents can select an arbitrary item. Rows carry `data-transcript-item-index`.
 *
 * The returned locator is keyed by that row index, not by DOM position, so it keeps naming
 * the same match when the list later recycles or reorders its row elements.
 */
export async function inDisplayOrder(matches: Locator, which: "first" | "last"): Promise<Locator> {
  await matches.first().waitFor({ state: "attached" });
  const indexes = await matches.evaluateAll((elements) =>
    elements.map((element) => {
      const row = element.closest<HTMLElement>("[data-transcript-item-index]");
      return row ? Number(row.dataset.transcriptItemIndex) : Number.NaN;
    }),
  );
  const rows = indexes.filter((index) => !Number.isNaN(index));
  if (rows.length === 0) return which === "first" ? matches.first() : matches.last();
  const index = which === "first" ? Math.min(...rows) : Math.max(...rows);
  const row = `[data-transcript-item-index="${index}"]`;
  const inRow = matches.and(matches.page().locator(`${row}, ${row} *`));
  return which === "first" ? inRow.first() : inRow.last();
}
