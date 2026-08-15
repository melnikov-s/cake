import type { ReactNode } from "react";

/** Immutable no-customization scene used by Cake's factory/recovery build. */
export default function FactoryGlobalScene({ children }: { children: ReactNode }) {
  return children;
}
