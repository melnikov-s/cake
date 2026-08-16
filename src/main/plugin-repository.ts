import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { cakePluginManifestSchema, pluginIdSchema, type CakePluginManifest, type PluginDiagnostic } from "../plugin/plugin-contract";
import { hasFileErrorCode } from "./file-errors";
import type { CakePaths } from "./cake-paths";
import { AtomicFileWriter } from "./atomic-file-writer";
import type { PluginStatus } from "../plugin/plugin-contract";

export interface DiscoveredPlugin {
  manifest: CakePluginManifest;
  root: string;
  rendererEntry?: string;
  backendEntry?: string;
  sceneEntry?: string;
}

export interface CustomizationSource {
  scene?: string;
  scenePluginId?: string;
  plugins: DiscoveredPlugin[];
  revision: string;
  diagnostics: PluginDiagnostic[];
  agentResources: { skills: string[]; prompts: string[]; extensions: string[] };
}

export interface PluginCreateOptions {
  id: string;
  name: string;
  renderer: boolean;
  backend: boolean;
  scene: boolean;
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
        statuses.push({ id: entry.name, name: manifest.name, enabled: manifest.id === entry.name && manifest.enabled, renderer: manifest.renderer, backend: manifest.backend, scene: manifest.scene, activeScene: manifest.activeScene, diagnostics: manifest.id === entry.name ? [] : [{ phase: "discovery", file: manifestPath, message: `Manifest ID ${manifest.id} must match directory ${entry.name}` }] });
      } catch (error) {
        statuses.push({ id: entry.name, name: entry.name, enabled: false, activeScene: false, diagnostics: [{ phase: "discovery", file: manifestPath, message: error instanceof Error ? error.message : String(error) }] });
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
    await this.writer.write(manifestPath, `${JSON.stringify({ ...manifest, enabled, activeScene: enabled ? manifest.activeScene : false }, null, 2)}\n`);
    return this.listPluginStatuses();
  }

  async setActiveScene(pluginId?: string) {
    const operation = async () => {
      await mkdir(this.paths.plugins, { recursive: true });
      const entries = await readdir(this.paths.plugins, { withFileTypes: true });
      let selected = false;
      const manifests: Array<{ path: string; manifest: CakePluginManifest }> = [];
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const path = join(this.paths.plugins, entry.name, "cake-plugin.json");
        let manifest: CakePluginManifest;
        try { manifest = cakePluginManifestSchema.parse(JSON.parse(await readFile(path, "utf8"))); }
        catch { continue; }
        if (manifest.id !== entry.name) continue;
        const activeScene = pluginId === manifest.id;
        if (activeScene) {
          if (!manifest.enabled || !manifest.scene) throw new Error(`Plugin ${pluginId} does not provide an enabled scene`);
          selected = true;
        }
        manifests.push({ path, manifest: { ...manifest, activeScene } });
      }
      if (pluginId && !selected) throw new Error(`Cake could not find enabled scene plugin ${pluginId}`);
      for (const item of manifests) await this.writer.write(item.path, `${JSON.stringify(item.manifest, null, 2)}\n`);
      return this.listPluginStatuses();
    };
    const result = this.authoringPending.then(operation, operation);
    this.authoringPending = result.then(() => undefined, () => undefined);
    return result;
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
    const roots = [{ label: "plugins", root: this.paths.plugins }];
    const files: string[] = [];
    for (const item of roots) {
      for (const file of await sourceFiles(item.root)) files.push(`${item.label}/${relative(item.root, file).split(sep).join("/")}`);
    }
    return { workingRevision: await hashRoots(roots), buildRevision: build.revision, files: files.sort() };
  }

  async readPluginFile(pluginId: string, relativePath: string) {
    const target = await this.pluginTarget(pluginId, relativePath, true);
    const content = await readFile(target, "utf8");
    if (content.length > 2_000_000) throw new Error("Customization source file is too large to read through Cake Chat");
    return content;
  }

  async writePluginFile(pluginId: string, relativePath: string, content: string, expectedWorkingRevision: string) {
    const operation = async () => {
      if (content.length > 2_000_000) throw new Error("Customization source file exceeds the 2 MB authoring limit");
      if (content.includes("\0")) throw new Error("Customization source must be text");
      const before = await this.authoringSnapshot();
      if (before.workingRevision !== expectedWorkingRevision) {
        throw new Error(`Customization working tree changed: expected ${expectedWorkingRevision}, found ${before.workingRevision}`);
      }
      const target = await this.pluginTarget(pluginId, relativePath, false);
      await mkdir(dirname(target), { recursive: true });
      await this.writer.write(target, content);
      return this.authoringSnapshot();
    };
    const result = this.authoringPending.then(operation, operation);
    this.authoringPending = result.then(() => undefined, () => undefined);
    return result;
  }

  async createPlugin(options: PluginCreateOptions, expectedWorkingRevision: string) {
    const operation = async () => {
      const parsedId = pluginIdSchema.parse(options.id);
      const name = options.name.trim();
      if (!name || name.length > 128) throw new Error("Plugin name must contain 1–128 characters");
      if (!options.renderer && !options.backend && !options.scene) throw new Error("A plugin must include a renderer, backend, or scene");
      const before = await this.authoringSnapshot();
      if (before.workingRevision !== expectedWorkingRevision) throw new Error(`Customization working tree changed: expected ${expectedWorkingRevision}, found ${before.workingRevision}`);
      const root = join(this.paths.plugins, parsedId);
      try { await lstat(root); throw new Error(`Plugin ${parsedId} already exists`); }
      catch (error) { if (!hasFileErrorCode(error, "ENOENT")) throw error; }
      const temporary = `${root}.tmp-${crypto.randomUUID()}`;
      await mkdir(temporary, { recursive: true });
      try {
        const manifest = cakePluginManifestSchema.parse({
          schemaVersion: 2, id: parsedId, name,
          renderer: options.renderer ? "renderer.tsx" : undefined,
          backend: options.backend ? "backend.ts" : undefined,
          scene: options.scene ? "scene.tsx" : undefined,
          activeScene: false, enabled: true
        });
        await writeFile(join(temporary, "cake-plugin.json"), `${JSON.stringify(manifest, null, 2)}\n`);
        if (options.renderer) await writeFile(join(temporary, "renderer.tsx"), `import { definePlugin } from "cake";\n\nexport default definePlugin({\n  id: ${JSON.stringify(parsedId)},\n  contributions: {}\n});\n`);
        if (options.backend) await writeFile(join(temporary, "backend.ts"), `import { definePluginBackend } from "cake/backend";\n\nexport default definePluginBackend({ methods: {} });\n`);
        if (options.scene) await writeFile(join(temporary, "scene.tsx"), `import { DefaultScene } from "cake";\n\nexport default function Scene() {\n  return <DefaultScene />;\n}\n`);
        await rename(temporary, root);
      } catch (error) {
        await rm(temporary, { recursive: true, force: true });
        throw error;
      }
      return this.authoringSnapshot();
    };
    const result = this.authoringPending.then(operation, operation);
    this.authoringPending = result.then(() => undefined, () => undefined);
    return result;
  }

  private async pluginTarget(pluginId: string, relativePath: string, mustExist: boolean) {
    const parsedId = pluginIdSchema.parse(pluginId);
    if (relativePath.includes("\0") || isAbsolute(relativePath)) throw new Error("Plugin paths must be relative text paths");
    const suffix = relativePath.replaceAll("\\", "/");
    if (!suffix) throw new Error("Plugin path must name a file");
    const canonicalRoot = await realpath(this.paths.plugins);
    const sourceRoot = await realpath(join(canonicalRoot, parsedId));
    if (!isWithin(canonicalRoot, sourceRoot) || basename(sourceRoot) !== parsedId) throw new Error("Plugin directory does not match its ID");
    const target = resolve(sourceRoot, suffix);
    if (!isWithin(sourceRoot, target)) throw new Error("Plugin path escapes its source root");
    let current = sourceRoot;
    const parentSegments = suffix.split("/").slice(0, -1);
    for (const segment of parentSegments) {
      current = join(current, segment);
      try {
        const entry = await lstat(current);
        if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error(`Plugin path crosses a non-directory entry: ${relativePath}`);
      } catch (error) { if (hasFileErrorCode(error, "ENOENT")) break; throw error; }
    }
    if (!mustExist) return target;
    const canonical = await realpath(target);
    if (!isWithin(sourceRoot, canonical) || !(await lstat(canonical)).isFile()) throw new Error("Plugin source is not a regular in-root file");
    return canonical;
  }

  async inspect(): Promise<CustomizationSource> {
    await mkdir(this.paths.plugins, { recursive: true });

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
        const resolveEntry = async (kind: "renderer" | "backend" | "scene", entryPath?: string) => {
          if (!entryPath) return undefined;
          const logicalEntry = resolve(canonicalRoot, entryPath);
          if (!isWithin(canonicalRoot, logicalEntry)) throw new Error(`Plugin ${kind} entry escapes its directory: ${entryPath}`);
          const resolvedEntry = await realpath(logicalEntry);
          if (!isWithin(canonicalRoot, resolvedEntry) || !(await lstat(resolvedEntry)).isFile()) throw new Error(`Plugin ${kind} entry is not a regular in-directory file: ${entryPath}`);
          return resolvedEntry;
        };
        plugins.push({
          manifest,
          root: canonicalRoot,
          rendererEntry: await resolveEntry("renderer", manifest.renderer),
          backendEntry: await resolveEntry("backend", manifest.backend),
          sceneEntry: await resolveEntry("scene", manifest.scene)
        });
      } catch (error) {
        diagnostics.push({ phase: "discovery", file: join(root, "cake-plugin.json"), message: error instanceof Error ? error.message : String(error) });
      }
    }
    plugins.sort((a, b) => a.manifest.id.localeCompare(b.manifest.id));
    const activeScenes = plugins.filter((plugin) => plugin.manifest.activeScene && plugin.sceneEntry);
    if (activeScenes.length > 1) diagnostics.push({ phase: "discovery", message: `Multiple plugins select an active scene: ${activeScenes.map((plugin) => plugin.manifest.id).join(", ")}` });
    const activeScene = activeScenes.length === 1 ? activeScenes[0] : undefined;
    const scene = activeScene?.sceneEntry;

    const agentResources: CustomizationSource["agentResources"] = { skills: [], prompts: [], extensions: [] };
    for (const plugin of plugins) {
      for (const [directory, target, directories] of [["skills", agentResources.skills, true], ["prompts", agentResources.prompts, false], ["pi-extensions", agentResources.extensions, false]] as const) {
        const resourceRoot = join(plugin.root, directory);
        let entries;
        try { entries = await readdir(resourceRoot, { withFileTypes: true }); }
        catch (error) { if (hasFileErrorCode(error, "ENOENT")) continue; throw error; }
        for (const entry of entries) {
          if (directories ? !entry.isDirectory() : !entry.isFile()) continue;
          const resource = await realpath(join(resourceRoot, entry.name));
          if (isWithin(plugin.root, resource)) target.push(resource);
        }
      }
    }

    const roots = plugins.map((plugin) => ({ label: `plugin:${plugin.manifest.id}`, root: plugin.root }));
    return { scene, scenePluginId: activeScene?.manifest.id, plugins, revision: await hashRoots(roots), diagnostics, agentResources };
  }

  /** Retains the exact regular files used to calculate a source revision. */
  async snapshotSource(source: CustomizationSource) {
    const destination = join(this.paths.recovery, "sources", source.revision);
    try { if ((await lstat(destination)).isDirectory()) return destination; }
    catch (error) { if (!hasFileErrorCode(error, "ENOENT")) throw error; }
    const temporary = `${destination}.tmp-${crypto.randomUUID()}`;
    const roots = source.plugins.map((plugin) => ({ label: join("plugins", plugin.manifest.id), root: plugin.root }));
    try {
      await mkdir(temporary, { recursive: true });
      for (const item of roots) {
        for (const file of await sourceFiles(item.root)) {
          const target = join(temporary, item.label, relative(item.root, file));
          await mkdir(dirname(target), { recursive: true });
          await copyFile(file, target);
        }
      }
      const snapshotRoots = source.plugins.map((plugin) => ({ label: `plugin:${plugin.manifest.id}`, root: join(temporary, "plugins", plugin.manifest.id) }));
      const snapshotRevision = await hashRoots(snapshotRoots);
      if (snapshotRevision !== source.revision) throw new Error(`Customization source changed while snapshotting revision ${source.revision}`);
      await mkdir(dirname(destination), { recursive: true });
      await rename(temporary, destination);
    } catch (error) {
      await rm(temporary, { recursive: true, force: true });
      if (hasFileErrorCode(error, "EEXIST")) return destination;
      throw error;
    }
    return destination;
  }
}
