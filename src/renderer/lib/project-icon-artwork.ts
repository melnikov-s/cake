import type { ProjectIconArtwork } from "../../contracts/projects/project-icon-generation";
import {
  PROJECT_ICON_DATA_MAX_LENGTH,
  type ProjectIcon,
} from "../../contracts/application/application-data";

/** Only locally authored tags/attributes and validated geometry; never raw model markup. */
export function projectIconArtworkUrl(artwork: ProjectIconArtwork) {
  // Re-check the tiny vocabulary here as well, before constructing an image URL.
  if (
    !/^#[0-9a-fA-F]{6}$/.test(artwork.background) ||
    artwork.paths.length < 1 ||
    artwork.paths.length > 16 ||
    artwork.paths.some(
      (path) =>
        !/^#[0-9a-fA-F]{6}$/.test(path.fill) ||
        !/^[MmLlHhVvCcSsQqTtAaZz0-9., +-]+$/.test(path.d) ||
        path.d.length > 2048,
    )
  )
    throw new Error("Unsupported SVG geometry");
  const paths = artwork.paths.map((path) => `<path d="${path.d}" fill="${path.fill}"/>`).join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 100 100"><rect width="100" height="100" fill="${artwork.background}"/>${paths}</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/** SVG is decoded only as an image, never inserted into the live document. */
export async function rasterizeProjectIcon(artwork: ProjectIconArtwork): Promise<ProjectIcon> {
  const image = new Image();
  const loaded = new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error("Could not render the generated icon"));
  });
  image.src = projectIconArtworkUrl(artwork);
  await loaded;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 256;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Could not prepare the generated icon");
  context.drawImage(image, 0, 0, 256, 256);
  const dataUrl = canvas.toDataURL("image/png");
  if (!dataUrl.startsWith("data:image/png;base64,"))
    throw new Error("Could not convert the generated icon to PNG");
  const data = dataUrl.slice("data:image/png;base64,".length);
  if (data.length > PROJECT_ICON_DATA_MAX_LENGTH) throw new Error("Generated icon exceeds 750 KB");
  return { mimeType: "image/png", data };
}
