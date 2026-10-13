import { Store } from "r-state-tree";
import type { WidgetPackageSnapshot } from "../../contracts/widgets/widget-packages";
import { ClientContext } from "./context/ClientContext";
import { describeError } from "../lib/error-details";

/** Settings drafts only; the connected backend owns shared widget dependencies. */
export class WidgetPackageSettingsStore extends Store {
  snapshot: WidgetPackageSnapshot | undefined;
  specifier = "";
  busy = false;
  error: string | undefined;
  notice: string | undefined;

  get client() {
    return ClientContext.consume(this)!;
  }

  async load() {
    await this.run("refresh");
  }
  async install() {
    if (!this.specifier.trim()) return;
    await this.run("install", this.specifier.trim());
  }
  async remove(name: string) {
    await this.run("remove", name);
  }

  private async run(action: "refresh" | "install" | "remove", value = "") {
    if (this.busy) return;
    this.busy = true;
    this.error = undefined;
    this.notice = undefined;
    try {
      const options = { signal: this.signal };
      const packages = this.client.widgetPackages;
      const snapshot =
        action === "refresh"
          ? await packages.list({}, options)
          : action === "install"
            ? await packages.install({ specifier: value, userApproved: true }, options)
            : await packages.remove({ name: value }, options);
      if (this.signal.aborted) return;
      this.snapshot = snapshot;
      if (action === "install") this.specifier = "";
      if (action !== "refresh")
        this.notice =
          action === "install"
            ? "Package installed. New widgets can use it immediately."
            : "Package removed. Accepted artifact browser output is retained.";
    } catch (error) {
      if (!this.signal.aborted) this.error = describeError(error).message;
    } finally {
      if (!this.signal.aborted) this.busy = false;
    }
  }
}
