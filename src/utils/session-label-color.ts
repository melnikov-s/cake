import type { SessionLabelColor } from "../domain/application/application-data";
import { sessionLabelPalette } from "./session-label-palette";

interface Oklab {
  readonly l: number;
  readonly a: number;
  readonly b: number;
}

const linear = (channel: number) =>
  channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;

const hexToOklab = (hex: string): Oklab => {
  const value = Number.parseInt(hex.slice(1), 16);
  const r = linear(((value >> 16) & 0xff) / 255);
  const g = linear(((value >> 8) & 0xff) / 255);
  const b = linear((value & 0xff) / 255);
  const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
  const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
  const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;
  const lRoot = Math.cbrt(l);
  const mRoot = Math.cbrt(m);
  const sRoot = Math.cbrt(s);
  return {
    l: 0.2104542553 * lRoot + 0.793617785 * mRoot - 0.0040720468 * sRoot,
    a: 1.9779984951 * lRoot - 2.428592205 * mRoot + 0.4505937099 * sRoot,
    b: 0.0259040371 * lRoot + 0.7827717662 * mRoot - 0.808675766 * sRoot,
  };
};

/** Perceptually blends ordered label colors. The first (primary) label owns half the mix. */
export function mergedSessionLabelColor(colors: readonly SessionLabelColor[]): string | undefined {
  const first = colors[0];
  if (!first) return undefined;
  if (colors.length === 1) return sessionLabelPalette[first];

  const secondaryWeight = 0.5 / (colors.length - 1);
  const mixed = colors.reduce<Oklab>(
    (result, color, index) => {
      const value = hexToOklab(sessionLabelPalette[color]);
      const weight = index === 0 ? 0.5 : secondaryWeight;
      return {
        l: result.l + value.l * weight,
        a: result.a + value.a * weight,
        b: result.b + value.b * weight,
      };
    },
    { l: 0, a: 0, b: 0 },
  );
  const chroma = Math.sqrt(mixed.a ** 2 + mixed.b ** 2);
  const hue = ((Math.atan2(mixed.b, mixed.a) * 180) / Math.PI + 360) % 360;
  return `oklch(${(mixed.l * 100).toFixed(2)}% ${chroma.toFixed(4)} ${hue.toFixed(2)})`;
}
