export type ModifierTapBinding = "AltLeft" | "AltRight";

export interface ModifierTapInput {
  readonly code: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
  readonly repeat: boolean;
  readonly isComposing: boolean;
}

/** A standalone Option/Alt tap completes on release, within 300 ms, without any other input. */
export function createModifierTapTracker(now: () => number = () => performance.now()) {
  const down = new Set<string>();
  let candidate: { code: ModifierTapBinding; started: number } | undefined;
  const reset = () => {
    candidate = undefined;
    down.clear();
  };
  return {
    reset,
    input(type: "keydown" | "keyup", event: ModifierTapInput): ModifierTapBinding | undefined {
      const side = event.code === "AltLeft" || event.code === "AltRight" ? event.code : undefined;
      const otherModifier = event.metaKey || event.ctrlKey || event.shiftKey;
      if (type === "keydown") {
        const alone = down.size === 0;
        candidate =
          side && alone && !event.repeat && !event.isComposing && !otherModifier
            ? { code: side, started: now() }
            : undefined;
        down.add(event.code);
        return;
      }
      const tap = candidate;
      candidate = undefined;
      down.delete(event.code);
      if (
        tap &&
        tap.code === side &&
        down.size === 0 &&
        !event.repeat &&
        !event.isComposing &&
        !otherModifier &&
        !event.altKey &&
        now() - tap.started <= 300
      )
        return side;
    },
  };
}
