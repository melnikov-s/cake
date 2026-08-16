import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { cakePluginManifestSchema, type CakePluginManifest, type PluginDiagnostic } from "../plugin/plugin-contract";
import type { CakePaths } from "./cake-paths";
import { AtomicFileWriter } from "./atomic-file-writer";
import type { PluginStatus } from "../plugin/plugin-contract";

const defaultGlobalScene = `import type { ReactNode } from "react";

export default function GlobalScene({ children }: { children: ReactNode }) {
  return children;
}
`;

export interface DiscoveredPlugin {
  manifest: CakePluginManifest;
  root: string;
  entry: string;
}

export interface CustomizationSource {
  scene: string;
  plugins: DiscoveredPlugin[];
  revision: string;
  diagnostics: PluginDiagnostic[];
  agentResources: { skills: string[]; prompts: string[]; extensions: string[] };
}

function isWithin(root: string, path: string) {
  const child = relative(root, path);
  return child === "" || (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}

async function sourceFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const visit = async (directory: string) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (["node_modules", ".git", "out", "dist"].includes(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) files.push(path);
    }
  };
  await visit(root);
  return files.sort();
}

async function hashRoots(roots: Array<{ label: string; root: string }>) {
  const hash = createHash("sha256");
  for (const item of roots) {
    for (const file of await sourceFiles(item.root)) {
      hash.update(item.label).update("\0").update(relative(item.root, file)).update("\0").update(await readFile(file)).update("\0");
    }
  }
  return hash.digest("hex");
}

export class PluginRepository {
  private readonly writer = new AtomicFileWriter();
  private authoringPending: Promise<void> = Promise.resolve();
  constructor(readonly paths: CakePaths) {}

  async listPluginStatuses(): Promise<PluginStatus[]> {
    await mkdir(this.paths.plugins, { recursive: true });
    const statuses: PluginStatus[] = [];
    for (const entry of await readdir(this.paths.plugins, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)+$/.test(entry.name)) continue;
      const manifestPath = join(this.paths.plugins, entry.name, "cake-plugin.json");
      try {
        const manifest = cakePluginManifestSchema.parse(JSON.parse(await readFile(manifestPath, "utf8")));
        statuses.push({ id: entry.name, enabled: manifest.id === entry.name && manifest.enabled, entry: manifest.entry, diagnostics: manifest.id === entry.name ? [] : [{ phase: "discovery", file: manifestPath, message: `Manifest ID ${manifest.id} must match directory ${entry.name}` }] });
      } catch (error) {
        statuses.push({ id: entry.name, enabled: false, entry: "", diagnostics: [{ phase: "discovery", file: manifestPath, message: error instanceof Error ? error.message : String(error) }] });
      }
    }
    return statuses.sort((a, b) => a.id.localeCompare(b.id));
  }

  async setEnabled(pluginId: string, enabled: boolean) {
    const root = await realpath(join(this.paths.plugins, pluginId));
    if (!isWithin(await realpath(this.paths.plugins), root) || basename(root) !== pluginId) throw new Error("Plugin directory does not match its ID");
    const manifestPath = join(root, "cake-plugin.json");
    const manifest = cakePluginManifestSchema.parse(JSON.parse(await readFile(manifestPath, "utf8")));
    if (manifest.id !== pluginId) throw new Error("Plugin manifest ID does not match its directory");
    await this.writer.write(manifestPath, `${JSON.stringify({ ...manifest, enabled }, null, 2)}\n`);
    return this.listPluginStatuses();
  }

  async deletePlugin(pluginId: string) {
    await mkdir(this.paths.plugins, { recursive: true });
    const pluginsRoot = await realpath(this.paths.plugins);
    const requestedRoot = join(pluginsRoot, pluginId);
    const root = await realpath(requestedRoot);
    if (!isWithin(pluginsRoot, root) || root !== requestedRoot || basename(root) !== pluginId) {
      throw new Error("Plugin directory does not match its ID");
    }
    let wasEnabled = false;
    try {
      const manifest = cakePluginManifestSchema.parse(JSON.parse(await readFile(join(root, "cake-plugin.json"), "utf8")));
      wasEnabled = manifest.id === pluginId && manifest.enabled;
    } catch {
      // Invalid plugin source is still removable after its directory is
      // independently constrained to the canonical plugin root.
    }
    await rm(root, { recursive: true });
    return { wasEnabled, plugins: await this.listPluginStatuses() };
  }

  async authoringSnapshot() {
    const build = await this.inspect();
    const roots = [{ label: "scenes", root: this.paths.scenes }, { label: "plugins", root: this.paths.plugins }];
    const files: string[] = [];
    for (const item of roots) {
      for (const file of await sourceFiles(item.root)) files.push(`${item.label}/${relative(item.root, file).split(sep).join("/")}`);
    }
    return { workingRevision: await hashRoots(roots), buildRevision: build.revision, files: files.sort() };
  }

  async readAuthoringFile(logicalPath: string) {
    const target = await this.authoringTarget(logicalPath, true);
    const content = await readFile(target, "utf8");
    if (content.length > 2_000_000) throw new Error("Customization source file is too large to read through global chat");
    return content;
  }

  async writeAuthoringFile(logicalPath: string, content: string, expectedWorkingRevision: string) {
    const operation = async () => {
      if (content.length > 2_000_000) throw new Error("Customization source file exceeds the 2 MB authoring limit");
      if (content.includes("\0")) throw new Error("Customization source must be text");
      const before = await this.authoringSnapshot();
      if (before.workingRevision !== expectedWorkingRevision) {
        throw new Error(`Customization working tree changed: expected ${expectedWorkingRevision}, found ${before.workingRevision}`);
      }
      const target = await this.authoringTarget(logicalPath, false);
      await mkdir(dirname(target), { recursive: true });
      await this.writer.write(target, content);
      return this.authoringSnapshot();
    };
    const result = this.authoringPending.then(operation, operation);
    this.authoringPending = result.then(() => undefined, () => undefined);
    return result;
  }

  private async authoringTarget(logicalPath: string, mustExist: boolean) {
    if (logicalPath.includes("\0") || isAbsolute(logicalPath)) throw new Error("Customization paths must be relative text paths");
    const normalized = logicalPath.replaceAll("\\", "/");
    const [scope, pluginId] = normalized.split("/");
    const root = scope === "scenes" ? this.paths.scenes : scope === "plugins" && pluginId ? join(this.paths.plugins, pluginId) : undefined;
    if (!root) throw new Error("Customization paths must be beneath scenes/ or plugins/<plugin-id>/");
    if (scope === "plugins") cakePluginManifestSchema.shape.id.parse(pluginId);
    const suffix = scope === "scenes" ? normalized.slice("scenes/".length) : normalized.split("/").slice(2).join("/");
    if (!suffix) throw new Error("Customization path must name a file");
    const canonicalRoot = await realpath(scope === "scenes" ? this.paths.scenes : this.paths.plugins);
    const sourceRoot = scope === "scenes" ? canonicalRoot : join(canonicalRoot, pluginId!);
    const target = resolve(sourceRoot, suffix);
    if (!isWithin(sourceRoot, target)) throw new Error("Customization path escapes its source root");
    let current = canonicalRoot;
    const parentSegments = [...(scope === "plugins" ? [pluginId!] : []), ...suffix.split("/").slice(0, -1)];
    for (const segment of parentSegments) {
      current = join(current, segment);
      try {
        const entry = await lstat(current);
        if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error(`Customization path crosses a non-directory entry: ${logicalPath}`);
      } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") break; throw error; }
    }
    if (!mustExist) return target;
    const canonical = await realpath(target);
    if (!isWithin(canonicalRoot, canonical) || !(await lstat(canonical)).isFile()) throw new Error("Customization source is not a regular in-root file");
    return canonical;
  }

  async inspect(): Promise<CustomizationSource> {
    await Promise.all([mkdir(this.paths.plugins, { recursive: true }), mkdir(this.paths.scenes, { recursive: true })]);
    const scenePath = join(this.paths.scenes, "global.tsx");
    try { await lstat(scenePath); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await writeFile(scenePath, defaultGlobalScene, { flag: "wx" });
    }
    const scene = await realpath(scenePath);

    const diagnostics: PluginDiagnostic[] = [];
    const plugins: DiscoveredPlugin[] = [];
    for (const entry of await readdir(this.paths.plugins, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const root = join(this.paths.plugins, entry.name);
      try {
        const manifest = cakePluginManifestSchema.parse(JSON.parse(await readFile(join(root, "cake-plugin.json"), "utf8")));
        if (manifest.id !== entry.name) throw new Error(`Manifest ID ${manifest.id} must match directory ${entry.name}`);
        if (!manifest.enabled) continue;
        const canonicalRoot = await realpath(root);
        const logicalEntry = resolve(canonicalRoot, manifest.entry);
        if (!isWithin(canonicalRoot, logicalEntry)) throw new Error(`Plugin entry escapes its directory: ${manifest.entry}`);
        const resolvedEntry = await realpath(logicalEntry);
        if (!isWithin(canonicalRoot, resolvedEntry) || !(await lstat(resolvedEntry)).isFile()) throw new Error(`Plugin entry is not a regular in-directory file: ${manifest.entry}`);
        plugins.push({ manifest, root: canonicalRoot, entry: resolvedEntry });
      } catch (error) {
        diagnostics.push({ phase: "discovery", file: join(root, "cake-plugin.json"), message: error instanceof Error ? error.message : String(error) });
      }
    }
    plugins.sort((a, b) => a.manifest.id.localeCompare(b.manifest.id));

    const agentResources = { skills: [] as string[], prompts: [] as string[], extensions: [] as string[] };
    for (const plugin of plugins) {
      for (const [directory, target, directories] of [["skills", agentResources.skills, true], ["prompts", agentResources.prompts, false], ["pi-extensions", agentResources.extensions, false]] as const) {
        const resourceRoot = join(plugin.root, directory);
        let entries;
        try { entries = await readdir(resourceRoot, { withFileTypes: true }); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
        for (const entry of entries) {
          if (directories ? !entry.isDirectory() : !entry.isFile()) continue;
          const resource = await realpath(join(resourceRoot, entry.name));
          if (isWithin(plugin.root, resource)) target.push(resource);
        }
      }
    }

    const roots = [{ label: "scene", root: this.paths.scenes }, ...plugins.map((plugin) => ({ label: `plugin:${plugin.manifest.id}`, root: plugin.root }))];
    return { scene, plugins, revision: await hashRoots(roots), diagnostics, agentResources };
  }

  /** Retains the exact regular files used to calculate a source revision. */
  async snapshotSource(source: CustomizationSource) {
    const destination = join(this.paths.recovery, "sources", source.revision);
    try { if ((await lstat(destination)).isDirectory()) return destination; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const temporary = `${destination}.tmp-${crypto.randomUUID()}`;
    const roots = [
      { label: "scenes", root: this.paths.scenes },
      ...source.plugins.map((plugin) => ({ label: join("plugins", plugin.manifest.id), root: plugin.root }))
    ];
    try {
      for (const item of roots) {
        for (const file of await sourceFiles(item.root)) {
          const target = join(temporary, item.label, relative(item.root, file));
          await mkdir(dirname(target), { recursive: true });
          await copyFile(file, target);
        }
      }
      const snapshotRoots = [
        { label: "scene", root: join(temporary, "scenes") },
        ...source.plugins.map((plugin) => ({ label: `plugin:${plugin.manifest.id}`, root: join(temporary, "plugins", plugin.manifest.id) }))
      ];
      const snapshotRevision = await hashRoots(snapshotRoots);
      if (snapshotRevision !== source.revision) throw new Error(`Customization source changed while snapshotting revision ${source.revision}`);
      await mkdir(dirname(destination), { recursive: true });
      await rename(temporary, destination);
    } catch (error) {
      await rm(temporary, { recursive: true, force: true });
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return destination;
      throw error;
    }
    return destination;
  }
}
