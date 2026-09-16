import { createHash } from "node:crypto";

interface ModuleEntry {
  readonly source: string;
  references: number;
}

export interface PublishedExtensionCompanionModule {
  readonly token: string;
  readonly release: () => void;
}

export class ExtensionCompanionModuleRegistry {
  private readonly modules = new Map<string, ModuleEntry>();

  publish(source: string): PublishedExtensionCompanionModule {
    const token = createHash("sha256").update(source).digest("hex");
    const existing = this.modules.get(token);
    if (existing) existing.references += 1;
    else this.modules.set(token, { source, references: 1 });

    let released = false;
    return {
      token,
      release: () => {
        if (released) return;
        released = true;
        const current = this.modules.get(token);
        if (!current) return;
        current.references -= 1;
        if (current.references === 0) this.modules.delete(token);
      },
    };
  }

  source(token: string): string | undefined {
    return this.modules.get(token)?.source;
  }
}
