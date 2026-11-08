import { createContext } from "react";

/** Shell-owned renderable area; standalone/companion windows use the full viewport. */
export const FullscreenViewportContext = createContext<HTMLElement | null>(null);
