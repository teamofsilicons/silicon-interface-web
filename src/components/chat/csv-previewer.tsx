"use client";

import * as React from "react";

import { parseCsvPreview } from "@/lib/csv-preview";
import { cn } from "@/lib/utils";

export function CsvPreviewer({ source }: { source: string }) {
  const preview = React.useMemo(() => parseCsvPreview(source), [source]);

  if (preview.columnCount === 0) {
    return (
      <div className="grid h-full min-h-[40dvh] place-items-center p-6 text-sm text-muted-foreground">
        this CSV file is empty.
      </div>
    );
  }

  const dataRowLabel = preview.rows.length === 1 ? "row" : "rows";
  const columnLabel = preview.columnCount === 1 ? "column" : "columns";
  const limited =
    preview.truncatedRows || preview.truncatedColumns || preview.truncatedCells;

  return (
    <div className="flex h-full min-h-[40dvh] min-w-0 flex-col bg-background">
      <div
        className="shrink-0 border-b bg-muted/40 px-4 py-2 text-xs text-muted-foreground"
        role="status"
      >
        {preview.truncatedRows ? "Showing the first " : "Showing "}
        {preview.rows.length.toLocaleString()} {dataRowLabel} ·{" "}
        {preview.columnCount.toLocaleString()} {columnLabel}
        {limited ? " · preview limited for performance" : ""}
      </div>
      <div className="min-h-0 min-w-0 flex-1 overflow-auto [overscroll-behavior:contain]">
        <table className="w-max min-w-full border-separate border-spacing-0 text-left font-mono text-xs">
          <caption className="sr-only">
            CSV preview with {preview.rows.length} data {dataRowLabel} and{" "}
            {preview.columnCount} {columnLabel}
          </caption>
          <thead className="sticky top-0 z-20 bg-muted text-foreground shadow-[0_1px_0_var(--border)]">
            <tr>
              <th
                scope="col"
                className="sticky left-0 z-30 w-12 min-w-12 border-r bg-muted px-2 py-2 text-right font-medium text-muted-foreground"
              >
                #
              </th>
              {preview.headers.map((header, index) => (
                <th
                  key={index}
                  scope="col"
                  className="w-48 min-w-48 max-w-72 border-r px-3 py-2 align-top font-semibold last:border-r-0"
                >
                  <span className="block max-h-20 overflow-hidden whitespace-pre-wrap break-words">
                    {header || `Column ${index + 1}`}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {preview.rows.map((row, rowIndex) => (
              <tr key={rowIndex} className="group even:bg-muted/20 hover:bg-accent/50">
                <th
                  scope="row"
                  className="sticky left-0 z-10 w-12 min-w-12 border-b border-r bg-background px-2 py-2 text-right align-top font-normal text-muted-foreground group-even:bg-muted group-hover:bg-accent"
                >
                  {rowIndex + 1}
                </th>
                {preview.headers.map((header, columnIndex) => {
                  const value = row[columnIndex] ?? "";
                  return (
                    <td
                      key={columnIndex}
                      aria-label={`${header || `Column ${columnIndex + 1}`}: ${value || "empty"}`}
                      className={cn(
                        "w-48 min-w-48 max-w-72 border-b border-r px-3 py-2 align-top last:border-r-0",
                        !value && "text-muted-foreground",
                      )}
                    >
                      <span className="block max-h-24 overflow-hidden whitespace-pre-wrap break-words">
                        {value || "—"}
                      </span>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
