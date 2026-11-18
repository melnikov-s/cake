import { useEffect, useRef, type FocusEvent, type PointerEvent } from "react";

/** Keep the toast visible while the pointer or keyboard focus is inside it. */
export function useToastInteraction(
  owner: { setToastPaused(id: string, paused: boolean): void },
  id: string,
) {
  const interaction = useRef({ pointer: false, focus: false });

  function update(kind: "pointer" | "focus", active: boolean) {
    const state = interaction.current;
    state[kind] = active;
    owner.setToastPaused(id, state.pointer || state.focus);
  }

  useEffect(
    () => () => {
      const state = interaction.current;
      if (!state.pointer && !state.focus) return;
      interaction.current = { pointer: false, focus: false };
      owner.setToastPaused(id, false);
    },
    [owner, id],
  );

  return {
    onPointerEnter: (event: PointerEvent) => {
      if (event.pointerType !== "touch") update("pointer", true);
    },
    onPointerLeave: (event: PointerEvent) => {
      if (event.pointerType !== "touch") update("pointer", false);
    },
    onFocus: () => update("focus", true),
    onBlur: (event: FocusEvent) => {
      if (!event.currentTarget.contains(event.relatedTarget)) update("focus", false);
    },
  };
}
