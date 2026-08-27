import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
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
    <div className="artifact-table">
      <div className="artifact-controls">
        <input
          aria-label="Filter table"
          placeholder="Filter rows"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <Button variant="outline" size="sm" onClick={exportCsv}>
          Export CSV
        </Button>
      </div>
      <div className="artifact-table-scroll">
        <table>
          <thead>
            <tr>
              {artifact.payload.selectable && <th aria-label="Selection" />}
              {artifact.payload.columns.map((column) => (
                <th key={column.id}>
                  <button onClick={() => chooseSort(column.id)}>
                    {column.label}
                    {sort?.column === column.id ? (sort.direction === 1 ? " ↑" : " ↓") : ""}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                {artifact.payload.selectable && (
                  <td>
                    <input
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
                  <td key={column.id}>{String(row[column.id] ?? "")}</td>
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
