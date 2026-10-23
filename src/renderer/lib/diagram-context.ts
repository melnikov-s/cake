import { createContext } from "react";

export const DiagramContext = createContext<{
  openFullscreen?(source: string): void;
  navigate?(href: string): void;
}>({});
