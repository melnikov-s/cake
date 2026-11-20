import type { LegendListRef } from "@legendapp/list/react";

/**
 * Shows a selected message from its start. A message whose start is above the
 * reading area is aligned to that start, even when the rest of it already covers
 * the viewport: Legend List's `scrollIndexIntoView` leaves such a message where
 * it is, so arrowing to a long newest answer showed only its end.
 */
export function revealTranscriptSelection(
  list: LegendListRef,
  { index, key, start, end }: { index: number; key: string; start: number; end: number },
) {
  // The anchor offset is how far the viewport top lies past the item's start.
  const anchor = list.anchorVisibleContent({ key, hold: false });
  if (anchor && -anchor.offset < start)
    // Legend List aligns the last item's end unless a view position is given.
    return list.scrollToIndex({ index, animated: false, viewOffset: start, viewPosition: 0 });
  return list.scrollIndexIntoView({ index, animated: false, viewportMargin: { start, end } });
}
