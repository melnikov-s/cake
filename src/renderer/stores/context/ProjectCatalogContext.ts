import { createContext } from "r-state-tree";
import type { ProjectCatalogStore } from "../ProjectCatalogStore";

/** The window's shared Project catalog. */
export const ProjectCatalogContext = createContext<ProjectCatalogStore>();
