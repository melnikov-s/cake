import { createContext } from "react";

// DOM placement is view-local; widget selection and resources remain Store-owned.
export const WidgetTabViewportContext = createContext<(element: HTMLDivElement | null) => void>(
  () => {},
);
