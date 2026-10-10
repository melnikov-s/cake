import type { Models } from "@earendil-works/pi-durable-ai";

/** SDK collections have prototype methods/private fields. Spreading them loses
 * those methods; unbound proxy calls lose their receiver. Overrides are request
 * adapters only, leaving the supplied collection and its credential state intact. */
export function durableModelFacade<Overrides extends Partial<Models>>(
  models: Models,
  overrides: Overrides,
): Models & Overrides {
  // SAFETY: every override key is served below; other SDK methods keep their original receiver.
  return new Proxy(models, {
    get(target, key) {
      if (Object.prototype.hasOwnProperty.call(overrides, key)) return Reflect.get(overrides, key);
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as Models & Overrides;
}
