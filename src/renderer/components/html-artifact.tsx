import type { CakeArtifactV1 } from "../../ipc/artifact-contract";

export function HtmlArtifact({
  artifact,
}: {
  artifact: Extract<CakeArtifactV1, { kind: "html" }>;
}) {
  return (
    <iframe
      className="artifact-html"
      title={artifact.title ?? artifact.id}
      sandbox=""
      referrerPolicy="no-referrer"
      srcDoc={isolatedDocument(
        artifact.payload.html,
        "img-src data:; media-src data:; style-src 'unsafe-inline'",
      )}
    />
  );
}

function isolatedDocument(body: string, policy: string) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; ${policy}; form-action 'none'; base-uri 'none'"><style>html{color-scheme:light dark;font:14px system-ui}body{margin:12px;overflow:auto}svg,img,video{max-width:100%;height:auto}</style></head><body>${body}</body></html>`;
}
