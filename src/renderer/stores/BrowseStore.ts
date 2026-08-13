import { Store, observable } from "r-state-tree";
import type { DesktopClient } from "../desktop-client";

export interface BrowseStoreProps {
  client: DesktopClient;
  projectPath(): string | undefined;
  reportError(error: unknown): void;
}

/** Owns the project-file browsing workflow and its take-latest loading policy. */
export class BrowseStore extends Store<BrowseStoreProps> {
  path: string | null | undefined;
  files: string[] = observable([]);
  loading = false;
  private revision = 0;

  async readFile(path: string) {
    const projectPath = this.props.projectPath();
    if (!projectPath) throw new Error("No project is open");
    return this.props.client.readWorkspaceFile(projectPath, path);
  }

  async open(path?: string) {
    const projectPath = this.props.projectPath();
    if (!projectPath) return;
    this.path = path ?? null;
    this.files.splice(0);
    const revision = ++this.revision;
    this.loading = true;
    try {
      const files = await this.props.client.listWorkspaceFiles(projectPath);
      if (this.signal.aborted || revision !== this.revision) return;
      this.files.splice(0, this.files.length, ...files);
      this.path = path && files.includes(path) ? path : null;
    } catch (error) {
      if (revision === this.revision) this.props.reportError(error);
    } finally {
      if (revision === this.revision) this.loading = false;
    }
  }

  select(path: string) {
    if (this.files.includes(path)) this.path = path;
  }

  focusPath(path: string) {
    if (this.files.includes(path)) this.path = path;
  }

  close() {
    this.revision += 1;
    this.path = undefined;
    this.loading = false;
  }

  reset() {
    this.close();
    this.files.splice(0);
  }
}
