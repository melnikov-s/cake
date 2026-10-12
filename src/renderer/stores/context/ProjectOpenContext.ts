import { createContext } from "r-state-tree";
import type { ProjectOpenStore } from "../ProjectOpenStore";

/** Project-selection intents shared by navigation and Project removal. */
export const ProjectOpenContext =
  createContext<
    Pick<ProjectOpenStore, "chooseProject" | "startOneOffChat" | "clear" | "activate">
  >();
