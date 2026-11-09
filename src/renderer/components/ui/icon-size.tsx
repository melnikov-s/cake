import { createContext, useContext, type ReactNode } from "react";

/** CSS-pixel glyph boxes, independent of button/touch target dimensions. */
export const iconSizes = { view: 24, navigation: 18, inline: 12 } as const;
export type IconSize = keyof typeof iconSizes;

const IconSizeContext = createContext<IconSize | undefined>(undefined);

/** Scope only Cake control glyphs; artwork, status dots and arbitrary SVGs opt out. */
export function IconSizeProvider({ size, children }: { size: IconSize; children: ReactNode }) {
  return <IconSizeContext.Provider value={size}>{children}</IconSizeContext.Provider>;
}

export function useIconRole() {
  return useContext(IconSizeContext);
}

export function useIconSize(fallback: number) {
  const role = useIconRole();
  return role ? iconSizes[role] : fallback;
}
