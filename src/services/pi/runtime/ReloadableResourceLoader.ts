import type { ResourceLoader } from "@earendil-works/pi-coding-agent";

/**
 * Stable Pi ResourceLoader identity whose complete configuration can change on reload.
 * A failed candidate reload leaves the previously loaded resources authoritative.
 */
export class ReloadableResourceLoader implements ResourceLoader {
  private current: ResourceLoader;

  constructor(private readonly make: () => ResourceLoader) {
    this.current = make();
  }

  getExtensions() {
    return this.current.getExtensions();
  }

  getSkills() {
    return this.current.getSkills();
  }

  getPrompts() {
    return this.current.getPrompts();
  }

  getThemes() {
    return this.current.getThemes();
  }

  getAgentsFiles() {
    return this.current.getAgentsFiles();
  }

  getSystemPrompt() {
    return this.current.getSystemPrompt();
  }

  getSystemPromptSource() {
    return this.current.getSystemPromptSource();
  }

  getAppendSystemPrompt() {
    return this.current.getAppendSystemPrompt();
  }

  getAppendSystemPromptSources() {
    return this.current.getAppendSystemPromptSources();
  }

  extendResources(paths: Parameters<ResourceLoader["extendResources"]>[0]) {
    this.current.extendResources(paths);
  }

  async reload(options?: Parameters<ResourceLoader["reload"]>[0]) {
    const candidate = this.make();
    await candidate.reload(options);
    this.current = candidate;
  }
}
