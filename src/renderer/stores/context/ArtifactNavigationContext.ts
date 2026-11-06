import { createContext } from "r-state-tree";
import type { ArtifactNavigationContext as NavigationContext } from "../../../contracts/artifacts/artifact-navigation-context";

export const ArtifactNavigationContext = createContext<() => NavigationContext>();
