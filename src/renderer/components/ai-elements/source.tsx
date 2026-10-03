/* Inspired by Vercel AI Elements sources.tsx at 0c1f5e8c75273f0e95c8faa031544a8aa2bb1a5b (Apache-2.0). */
import { Link } from "@/components/ui/link";

export function Source({ title, url }: { title: string; url: string }) {
  return (
    <Link href={url} target="_blank" rel="noreferrer">
      {title}
    </Link>
  );
}
