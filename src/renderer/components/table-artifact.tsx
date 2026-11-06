import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { SearchIcon } from "@/components/ui/icons";
import { Input } from "@/components/ui/input";
import type { CakeArtifactV1 } from "../../contracts/artifacts/artifact-contract";
import type { JsonValue } from "../../contracts/serialization/json-contract";

export function TableArtifact({
  artifact,
}: {
  artifact: Extract<CakeArtifactV1, { kind: "table" }>;
}) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<{ column: string; direction: 1 | -1 }>();
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const rows = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    const filtered = needle
      ? artifact.payload.rows.filter((row) =>
          Object.values(row).some((value) =>
            String(value ?? "")
              .toLocaleLowerCase()
              .includes(needle),
          ),
        )
      : artifact.payload.rows.slice();
    if (sort)
      filtered.sort(
        (left, right) => compare(left[sort.column], right[sort.column]) * sort.direction,
      );
    return filtered;
  }, [artifact.payload.rows, query, sort]);
  const chooseSort = (column: string) =>
    setSort((current) =>
      current?.column === column
        ? { column, direction: current.direction === 1 ? -1 : 1 }
        : { column, direction: 1 },
    );
  const exportCsv = () =>
    download(
      `${artifact.id}.csv`,
      [
        artifact.payload.columns.map((column) => column.label),
        ...rows.map((row) =>
          artifact.payload.columns.map((column) => String(row[column.id] ?? "")),
        ),
      ]
        .map((row) => row.map(csvCell).join(","))
        .join("\n"),
      "text/csv",
    );
  return (
    <div className="grid gap-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2 pr-10">
        <div className="relative max-w-xs flex-1">
          <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground">
            <SearchIcon size={13} />
          </span>
          <Input
            size="sm"
            className="pl-8 text-xs"
            aria-label="Filter table"
            placeholder="Filter rows…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <div className="flex items-center gap-2">
          <span className="font-mono text-xs text-muted-foreground tabular-nums">
            {rows.length} {rows.length === 1 ? "row" : "rows"}
          </span>
          <Button variant="outline" size="sm" onClick={exportCsv}>
            Export CSV
          </Button>
        </div>
      </div>
      <div className="max-h-[28rem] overflow-auto rounded-lg border border-border/80 bg-card/40">
        <table data-slot="artifact-table" className="w-full border-collapse text-left text-xs">
          <thead>
            <tr className="sticky top-0 z-1 bg-muted/90 backdrop-blur-sm">
              {artifact.payload.selectable && (
                <th className="w-9 border-b border-border/75 px-3 py-2" aria-label="Selection" />
              )}
              {artifact.payload.columns.map((column) => (
                <th
                  className="border-b border-border/75 px-3 py-2 font-semibold text-foreground"
                  key={column.id}
                >
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-auto p-0 font-semibold text-foreground hover:bg-transparent hover:underline"
                    onClick={() => chooseSort(column.id)}
                  >
                    {column.label}
                    {sort?.column === column.id ? (sort.direction === 1 ? " ↑" : " ↓") : ""}
                  </Button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border/60">
            {rows.map((row) => (
              <tr className="transition-colors hover:bg-muted/40" key={row.id}>
                {artifact.payload.selectable && (
                  <td className="px-3 py-2">
                    <Input
                      type="checkbox"
                      aria-label={`Select ${row.id}`}
                      checked={selected.has(row.id)}
                      onChange={() =>
                        setSelected((current) => {
                          const next = new Set(current);
                          if (next.has(row.id)) next.delete(row.id);
                          else next.add(row.id);
                          return next;
                        })
                      }
                    />
                  </td>
                )}
                {artifact.payload.columns.map((column) => (
                  <td className="px-3 py-2 text-foreground tabular-nums" key={column.id}>
                    {String(row[column.id] ?? "")}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function compare(left: JsonValue | undefined, right: JsonValue | undefined) {
  return isNumber(left) && isNumber(right)
    ? left - right
    : String(left ?? "").localeCompare(String(right ?? ""), undefined, { numeric: true });
}
function isNumber(value: JsonValue | undefined): value is number {
  return typeof value === "number";
}
function csvCell(value: string) {
  return /[",\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}
function download(name: string, content: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
