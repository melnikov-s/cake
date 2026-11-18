import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

export async function refreshPiModelRuntime(
  runtime: ModelRuntime,
  options: NonNullable<Parameters<ModelRuntime["refresh"]>[0]>,
): Promise<void> {
  options.signal?.throwIfAborted();
  const result = await runtime.refresh(options);
  options.signal?.throwIfAborted();
  // Pi retains successful provider updates even when a sibling provider fails.
  if (result.errors.size > 0)
    throw new Error(
      [...result.errors].map(([provider, error]) => `${provider}: ${error.message}`).join("; "),
    );
}
