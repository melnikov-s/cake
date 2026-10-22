import { Store, untracked } from "r-state-tree";
import type { VocabularyChange, VocabularyPage } from "../../contracts/dictation/vocabulary";
import type { Client } from "../client/Client";

/** Main owns persistence and CAS. This Store owns only the settings list projection. */
export class DictationVocabularyStore extends Store<{
  client: Client["dictation"];
  revision: number | undefined;
}> {
  page: typeof VocabularyPage.Type | undefined;
  query = "";
  offset = 0;
  error: string | undefined;
  busy = false;
  private request = 0;

  constructor(props: DictationVocabularyStore["props"]) {
    super(props);
    this.effect(() => {
      const revision = this.props.revision;
      if (revision !== undefined)
        untracked(() => {
          void this.refresh();
        });
    });
  }
  async refresh() {
    const request = ++this.request;
    try {
      const pagination = { offset: this.offset, limit: 20 };
      const input = this.query ? { ...pagination, query: this.query } : pagination;
      const page = await this.props.client.listVocabulary(input, { signal: this.signal });
      if (request !== this.request || this.signal.aborted) return;
      this.page = page;
      this.error = undefined;
    } catch (error) {
      if (request === this.request && !this.signal.aborted)
        this.error = error instanceof Error ? error.message : String(error);
    }
  }
  search(query: string) {
    this.query = query;
    this.offset = 0;
    void this.refresh();
  }
  go(offset: number) {
    this.offset = offset;
    void this.refresh();
  }
  async change(change: VocabularyChange): Promise<boolean> {
    if (this.busy) return false;
    this.busy = true;
    this.error = undefined;
    try {
      await this.props.client.changeVocabulary(change, { signal: this.signal });
      if (this.signal.aborted) return false;
      await this.refresh();
      return true;
    } catch (error) {
      if (!this.signal.aborted) this.error = error instanceof Error ? error.message : String(error);
      return false;
    } finally {
      this.busy = false;
    }
  }
}
