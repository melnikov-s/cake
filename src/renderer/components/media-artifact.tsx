import type { CakeArtifactV1 } from "../../ipc/artifact-contract";

export function MediaArtifact({
  artifact,
}: {
  artifact: Extract<CakeArtifactV1, { kind: "media" }>;
}) {
  const common = {
    src: artifact.payload.src,
    title: artifact.title,
    referrerPolicy: "no-referrer" as const,
  };
  if (artifact.payload.mediaType === "image")
    return <img {...common} alt={artifact.payload.alt ?? ""} />;
  if (artifact.payload.mediaType === "audio") return <audio {...common} controls />;
  if (artifact.payload.mediaType === "video") return <video {...common} controls />;
  return <iframe className="artifact-document" {...common} sandbox="" />;
}
