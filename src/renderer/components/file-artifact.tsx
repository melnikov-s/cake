import { useEffect, useMemo } from "react";
import { Markdown } from "@/components/ai-elements/markdown";
import { Button } from "@/components/ui/button";
import type { CakeArtifactV1 } from "../../ipc/artifact-contract";

export function FileArtifact({
  artifact,
}: {
  artifact: Extract<CakeArtifactV1, { kind: "file" }>;
}) {
  const { name, mimeType, data, byteSize } = artifact.payload;
  const bytes = useMemo(() => decodeBase64(data), [data]);
  const url = useMemo(
    () => URL.createObjectURL(new Blob([bytes], { type: mimeType })),
    [bytes, mimeType],
  );
  useEffect(() => () => URL.revokeObjectURL(url), [url]);

  const download = () => {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = name;
    anchor.click();
  };
  const metadata = `${mimeType} · ${formatBytes(byteSize)}`;

  if (mimeType === "text/markdown") return <Markdown>{new TextDecoder().decode(bytes)}</Markdown>;
  if (mimeType.startsWith("text/") || isTextualApplication(mimeType))
    return (
      <pre className="overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-relaxed">
        {new TextDecoder().decode(bytes)}
      </pre>
    );
  if (mimeType.startsWith("image/"))
    return (
      <img
        className="max-h-full max-w-full object-contain"
        src={url}
        alt={artifact.title ?? name}
      />
    );
  if (mimeType.startsWith("audio/"))
    return <audio className="w-full" src={url} title={artifact.title ?? name} controls />;
  if (mimeType.startsWith("video/"))
    return (
      <video className="max-h-full w-full" src={url} title={artifact.title ?? name} controls />
    );
  if (mimeType === "application/pdf")
    return (
      <iframe
        className="min-h-96 w-full border-0 bg-background"
        src={url}
        title={artifact.title ?? name}
        sandbox=""
      />
    );

  return (
    <div className="flex min-h-48 flex-col items-center justify-center gap-3 text-center">
      <div>
        <p className="font-medium text-foreground">{name}</p>
        <p className="mt-1 text-xs text-muted-foreground">{metadata}</p>
      </div>
      <Button variant="outline" size="sm" onClick={download}>
        Download file
      </Button>
    </div>
  );
}

function decodeBase64(data: string) {
  const binary = atob(data);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function isTextualApplication(mimeType: string) {
  return [
    "application/json",
    "application/xml",
    "application/yaml",
    "application/javascript",
  ].includes(mimeType);
}

function formatBytes(byteSize: number) {
  if (byteSize < 1_024) return `${byteSize} B`;
  if (byteSize < 1_048_576) return `${(byteSize / 1_024).toFixed(1)} KB`;
  return `${(byteSize / 1_048_576).toFixed(1)} MB`;
}
