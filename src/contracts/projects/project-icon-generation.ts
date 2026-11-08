import { Schema } from "effect";

/**
 * A deliberately small SVG vocabulary. No arbitrary markup, attributes, URLs,
 * CSS, text, references, animation or embedded content can cross this boundary.
 */
const color = Schema.String.check(Schema.isPattern(/^#[0-9a-fA-F]{6}$/));
export const ProjectIconArtwork = Schema.Struct({
  background: color,
  paths: Schema.Array(
    Schema.Struct({
      d: Schema.String.check(
        Schema.isMinLength(1),
        Schema.isMaxLength(2048),
        Schema.isPattern(/^[MmLlHhVvCcSsQqTtAaZz0-9., +-]+$/),
      ),
      fill: color,
    }),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(16)),
});
export interface ProjectIconArtwork extends Schema.Schema.Type<typeof ProjectIconArtwork> {}
