/* Inspired by Vercel AI Elements sources.tsx at 0c1f5e8c75273f0e95c8faa031544a8aa2bb1a5b (Apache-2.0). */
export function Source({ title, url }: { title: string; url: string }) {
  return (
    <a
      className="inline-flex rounded-full border border-border px-3 py-1 font-mono text-[0.68rem] text-muted-foreground hover:text-foreground"
      href={url}
      target="_blank"
      rel="noreferrer"
    >
      {title}
    </a>
  );
}
