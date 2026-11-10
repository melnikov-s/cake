import { fireEvent } from "@testing-library/react";

/** The reader scrolls up at the start of the transcript. Real list scrolling and
 * the reading position across prepended pages are verified in Electron. */
export function scrollTranscriptEarlier(indicator: HTMLElement) {
  const scroller = indicator.closest<HTMLElement>(".transcript")!;
  scroller.scrollTop = 0;
  fireEvent.wheel(scroller, { deltaY: -680 });
}
