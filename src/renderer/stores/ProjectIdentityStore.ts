import { Store } from "r-state-tree";
import type { ProjectIcon } from "../../contracts/application/application-data";
import { PROJECT_ICON_DATA_MAX_LENGTH } from "../../contracts/application/application-data";
import type { CakeModelChoice } from "../../contracts/model-presets/cake-model-selection";
import type { ProjectIconArtwork } from "../../contracts/projects/project-icon-generation";
import { projectIconArtworkUrl, rasterizeProjectIcon } from "../lib/project-icon-artwork";
import { describeError } from "../lib/error-details";
import { ClientContext } from "./context/ClientContext";
import { ModelCatalogContext } from "./context/ModelCatalogContext";
import { ProjectIdentityContext } from "./context/ProjectIdentityContext";

/** Dialog-local identity, model selection and unaccepted icon preview. Never persists. */
export class ProjectIdentityStore extends Store {
  name = "";
  icon: ProjectIcon | undefined;
  model: CakeModelChoice = { source: "utility" };
  preview: ProjectIconArtwork | undefined;
  choosingIcon = false;
  generating = false;
  accepting = false;
  error: string | undefined;
  private request: AbortController | undefined;
  private revision = 0;

  get client() {
    return ClientContext.consume(this)!;
  }
  get catalog() {
    return ModelCatalogContext.consume(this)!;
  }
  get preferences() {
    return ProjectIdentityContext.consume(this)!();
  }
  get busy() {
    return this.choosingIcon || this.generating || this.accepting;
  }
  get valid() {
    return this.name.trim().length > 0 && this.name.trim().length <= 512;
  }
  get previewUrl() {
    return this.preview ? projectIconArtworkUrl(this.preview) : undefined;
  }
  get modelLabel() {
    switch (this.model.source) {
      case "utility":
        return "Utility model";
      case "default":
        return "Default model";
      case "model":
        return this.model.model.modelId;
      case "preset": {
        const id = this.model.presetId;
        return (
          this.preferences.presets.find((preset) => preset.id === id)?.name ?? "Deleted preset"
        );
      }
      case "inherit":
        return "Default model";
    }
  }

  reset(name: string, icon?: ProjectIcon) {
    this.cancel();
    this.name = name;
    this.icon = icon;
    this.model = { source: "utility" };
    this.preview = undefined;
    this.error = undefined;
  }
  cancel() {
    this.revision += 1;
    this.request?.abort();
    this.request = undefined;
    this.choosingIcon = this.generating = this.accepting = false;
    this.preview = undefined;
  }
  setName(name: string) {
    this.name = name;
  }
  setModel(model: CakeModelChoice) {
    this.model = model;
  }
  removeIcon() {
    this.icon = undefined;
    this.error = undefined;
  }
  discardPreview() {
    this.preview = undefined;
  }

  async chooseIcon() {
    if (this.busy) return;
    const revision = this.revision;
    this.choosingIcon = true;
    this.error = undefined;
    try {
      const selected = await this.client.filesystem.chooseAttachments({ signal: this.signal });
      if (this.signal.aborted || revision !== this.revision || selected.length === 0) return;
      const image = selected.find(
        (item): item is Extract<(typeof selected)[number], { kind: "image" }> =>
          item.kind === "image",
      );
      if (
        !image ||
        (image.mimeType !== "image/png" &&
          image.mimeType !== "image/jpeg" &&
          image.mimeType !== "image/gif" &&
          image.mimeType !== "image/webp")
      ) {
        this.error = "Choose a PNG, JPEG, GIF, or WebP image";
        return;
      }
      if (image.data.length > PROJECT_ICON_DATA_MAX_LENGTH) {
        this.error = "Project icons must be smaller than 750 KB";
        return;
      }
      this.icon = { mimeType: image.mimeType, data: image.data };
      this.preview = undefined;
    } catch (error) {
      if (!this.signal.aborted && revision === this.revision)
        this.error = describeError(error).message;
    } finally {
      if (revision === this.revision) this.choosingIcon = false;
    }
  }

  async generate() {
    if (!this.valid || this.busy) return;
    const revision = this.revision;
    const request = new AbortController();
    this.request = request;
    this.generating = true;
    this.error = undefined;
    try {
      const preview = await this.client.workspaces.generateProjectIcon(
        { name: this.name.trim(), model: this.model },
        { signal: AbortSignal.any([this.signal, request.signal]) },
      );
      if (this.signal.aborted || revision !== this.revision) return;
      projectIconArtworkUrl(preview); // Validate before even previewing in an image.
      this.preview = preview;
    } catch (error) {
      if (!this.signal.aborted && revision === this.revision)
        this.error = describeError(error).message;
    } finally {
      if (revision === this.revision) {
        this.generating = false;
        this.request = undefined;
      }
    }
  }

  async acceptPreview() {
    if (!this.preview || this.busy) return;
    const revision = this.revision;
    const preview = this.preview;
    this.accepting = true;
    this.error = undefined;
    try {
      const icon = await rasterizeProjectIcon(preview);
      if (this.signal.aborted || revision !== this.revision) return;
      this.icon = icon;
      this.preview = undefined;
    } catch (error) {
      if (!this.signal.aborted && revision === this.revision)
        this.error = describeError(error).message;
    } finally {
      if (revision === this.revision) this.accepting = false;
    }
  }
}
