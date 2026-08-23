import { useEffect, useState } from "react";
import mermaid from "mermaid";
import type { CakeArtifactV1 } from "../../ipc/artifact-contract";

export function DiagramArtifact({
  artifact,
}: {
  artifact: Extract<CakeArtifactV1, { kind: "diagram" }>;
}) {
  const [svg, setSvg] = useState<string>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let active = true;
    mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: "neutral" });
    void mermaid
      .render(
        `cake-diagram-${artifact.id.replace(/[^A-Za-z0-9]/g, "-")}-${artifact.revision}`,
        artifact.payload.source,
      )
      .then((result) => {
        if (active) setSvg(result.svg);
      })
      .catch((reason) => {
        if (active) setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      active = false;
    };
  }, [artifact.id, artifact.payload.source, artifact.revision]);
  if (error)
    return (
      <div className="notice notice-error">
        <strong>Diagram could not render</strong>
        <span>{error}</span>
      </div>
    );
  return svg ? (
    <iframe
      className="artifact-diagram"
      title={artifact.title ?? artifact.id}
      sandbox=""
      srcDoc={isolatedDocument(svg, "img-src data:; style-src 'unsafe-inline'")}
    />
  ) : (
    <p>Rendering diagram…</p>
  );
}

function isolatedDocument(body: string, policy: string) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; ${policy}; form-action 'none'; base-uri 'none'"><style>html{color-scheme:light dark;font:14px system-ui}body{margin:12px;overflow:auto}svg,img,video{max-width:100%;height:auto}</style></head><body>${body}</body></html>`;
}
