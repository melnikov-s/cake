import { Store, snapshot } from "r-state-tree";
import { ProjectCatalogContext } from "./context/ProjectCatalogContext";

/** Owns the window's session destination picker. Only the last Project choice
 * is persisted; open/filter state is ephemeral. Creation remains with the existing workflows. */
export class NewSessionStore extends Store<{
  createCakeChat(): void;
  createProjectSession(path: string): void;
}> {
  open = false;
  @snapshot lastProjectPath: string | undefined;

  private get projects() {
    return ProjectCatalogContext.consume(this)!;
  }

  get initialChoiceId() {
    // Keep the preference while the Project catalog is still loading. The dialog
    // falls back to its first option whenever this destination is unavailable.
    return this.lastProjectPath ?? "cake-chat";
  }

  rememberProject(path: string) {
    this.lastProjectPath = path;
  }

  get choices() {
    return [
      { id: "cake-chat", label: "Cake Chat", description: "Chat with Cake" },
      ...this.projects.orderedProjectPaths.map((path) => ({
        id: path,
        label: this.projects.nameForPath(path),
        description: path,
      })),
    ];
  }

  show() {
    this.open = true;
  }

  close() {
    this.open = false;
  }

  select(id: string) {
    if (!this.open || !this.choices.some((choice) => choice.id === id)) return;
    this.close();
    if (id === "cake-chat") this.props.createCakeChat();
    else this.props.createProjectSession(id);
  }
}
