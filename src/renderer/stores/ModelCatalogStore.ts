import { Store, batch, observable } from "r-state-tree";
import type { ModelOption } from "../../contracts/conversations/session-contract";
import type { PiNonChatModel } from "../../contracts/pi/model-data";
import { describeError } from "../lib/error-details";
import { ClientContext } from "./context/ClientContext";

/** Window-owned directory catalog. Runtime capabilities stay on each Conversation. */
export class ModelCatalogStore extends Store {
  readonly models: ModelOption[] = observable([]);
  readonly nonChatModels: PiNonChatModel[] = observable([]);
  loading = true;
  error: ReturnType<typeof describeError> | undefined;
  private loaded = false;
  private pending: Promise<void> | undefined;
  private request: AbortController | undefined;

  get client() {
    return ClientContext.consume(this)!;
  }

  get modelsByProvider() {
    return this.groupModels(this.models);
  }

  get allModelsByProvider() {
    return this.groupModels([...this.models, ...this.nonChatModels]);
  }

  /** Share initial loading; picker opens never retain or reload a private copy. */
  ensureLoaded(): Promise<void> {
    if (this.pending) return this.pending;
    if (this.loaded || this.signal.aborted) return Promise.resolve();
    return this.reload();
  }

  /** Re-read after an authority change such as provider login or logout. */
  reload() {
    return this.load(false);
  }

  /** Refresh the authority and its projection as one take-latest operation. */
  refresh() {
    return this.load(true);
  }

  private load(refresh: boolean): Promise<void> {
    if (this.signal.aborted) return Promise.resolve();
    this.request?.abort();
    const request = new AbortController();
    this.request = request;
    const signal = AbortSignal.any([this.signal, request.signal]);
    this.loading = true;
    this.error = undefined;
    const pending = Promise.resolve().then(async () => {
      try {
        if (signal.aborted) return;
        if (refresh) await this.client.models.refresh({ signal });
        if (signal.aborted) return;
        const [models, nonChatModels] = await Promise.allSettled([
          this.client.models.list({ signal }),
          this.client.nonChatModels.list({ signal }),
        ]);
        if (signal.aborted) return;
        batch(() => {
          if (models.status === "fulfilled")
            this.models.splice(0, this.models.length, ...models.value);
          if (nonChatModels.status === "fulfilled")
            this.nonChatModels.splice(0, this.nonChatModels.length, ...nonChatModels.value);
          this.loaded = models.status === "fulfilled" && nonChatModels.status === "fulfilled";
          if (models.status === "rejected") this.error = describeError(models.reason);
          else if (nonChatModels.status === "rejected")
            this.error = describeError(nonChatModels.reason);
        });
      } catch (error) {
        if (!signal.aborted) this.error = describeError(error);
      } finally {
        if (!signal.aborted) {
          this.loading = false;
          this.pending = undefined;
        }
      }
    });
    this.pending = pending;
    return pending;
  }

  private groupModels<M extends ModelOption | PiNonChatModel>(models: readonly M[]) {
    const groups = new Map<string, { name: string; models: M[] }>();
    for (const model of models) {
      const group = groups.get(model.provider) ?? { name: model.providerName, models: [] };
      group.models.push(model);
      groups.set(model.provider, group);
    }
    return [...groups.entries()].map(([id, group]) => ({ id, ...group }));
  }
}
