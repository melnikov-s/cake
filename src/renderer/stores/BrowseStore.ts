import { Store, observable } from "r-state-tree";
import type { DesktopClient } from "../desktop-client";
import { describeError } from "../error-details";

export interface BrowseStoreProps {
  client: Pick<DesktopClient, "readWorkspaceFile" | "listWorkspaceFiles">;
  projectPath(): string | undefined;
}

/** Owns the project-file browsing workflow and its take-latest loading policy. */
export class BrowseStore extends Store<BrowseStoreProps> {
  path: string | null | undefined;
  files: string[] = observable([]);
  loading = false;
  error: string | undefined;
  errorDetails: string | undefined;
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
    this.error = undefined;
    this.errorDetails = undefined;
    try {
      const files = await this.props.client.listWorkspaceFiles(projectPath);
      if (this.signal.aborted || revision !== this.revision) return;
      this.files.splice(0, this.files.length, ...files);
      this.path = path && files.includes(path) ? path : null;
    } catch (error) {
      if (revision === this.revision) {
        const described = describeError(error);
        this.error = described.message;
        this.errorDetails = described.details;
      }
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
    this.error = undefined;
    this.errorDetails = undefined;
  }

  reset() {
    this.close();
    this.files.splice(0);
  }
}
