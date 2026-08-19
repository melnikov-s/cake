export type PluginBackendValue =
  | null
  | boolean
  | number
  | string
  | PluginBackendValue[]
  | { [key: string]: PluginBackendValue };

export interface PluginBackendMethodContext {
  signal: AbortSignal;
  emit(name: string, value: PluginBackendValue): void;
}

export type PluginBackendMethod = (
  input: PluginBackendValue,
  context: PluginBackendMethodContext,
) => PluginBackendValue | Promise<PluginBackendValue>;

export interface CakePluginBackend {
  methods: Record<string, PluginBackendMethod>;
  start?(context: Pick<PluginBackendMethodContext, "emit">): void | Promise<void>;
  dispose?(): void | Promise<void>;
}

/** Type helper for unrestricted plugin backend modules. */
export function definePluginBackend<const Backend extends CakePluginBackend>(
  backend: Backend,
): Backend {
  return backend;
}
