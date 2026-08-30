import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { CakeArtifactV1 } from "../../ipc/artifact-contract";
import type { JsonValue } from "../../ipc/json-contract";

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
    <div className="grid gap-3">
      <div className="flex items-center gap-2">
        <Input
          className="h-8 text-xs"
          aria-label="Filter table"
          placeholder="Filter rows"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <Button variant="outline" size="sm" onClick={exportCsv}>
          Export CSV
        </Button>
      </div>
      <div className="max-h-[28rem] overflow-auto rounded-lg border border-border">
        <table className="w-full border-collapse text-left text-xs">
          <thead>
            <tr className="sticky top-0 z-1 bg-muted">
              {artifact.payload.selectable && (
                <th className="border-b border-border p-2.5" aria-label="Selection" />
              )}
              {artifact.payload.columns.map((column) => (
                <th
                  className="border-b border-border p-2.5 font-semibold text-foreground"
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
          <tbody className="divide-y divide-border">
            {rows.map((row) => (
              <tr className="hover:bg-muted/50 transition-colors" key={row.id}>
                {artifact.payload.selectable && (
                  <td className="p-2.5">
                    <input
                      type="checkbox"
                      className="accent-primary"
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
                  <td className="p-2.5 text-foreground" key={column.id}>
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
