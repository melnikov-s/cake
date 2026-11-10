import { render } from "@testing-library/react";
import type { ReactElement } from "react";

/** Content proof only. Native layout, alignment and scrolling belong in Electron tests. */
export function renderTranscriptContent(content: ReactElement) {
  return render(<>{content}</>);
}
