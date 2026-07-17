export interface CsvPreviewOptions {
  maxRows?: number;
  maxColumns?: number;
  maxCellCharacters?: number;
}

export interface CsvPreviewData {
  headers: string[];
  rows: string[][];
  columnCount: number;
  truncatedRows: boolean;
  truncatedColumns: boolean;
  truncatedCells: boolean;
}

const DEFAULT_MAX_ROWS = 250;
const DEFAULT_MAX_COLUMNS = 50;
const DEFAULT_MAX_CELL_CHARACTERS = 10_000;

/**
 * Parse enough RFC 4180-style CSV for an interactive preview without allowing
 * a very large attachment to create an unbounded table. The first record is
 * treated as the header, matching spreadsheet import conventions.
 */
export function parseCsvPreview(
  source: string,
  options: CsvPreviewOptions = {},
): CsvPreviewData {
  const maxRows = positiveLimit(options.maxRows, DEFAULT_MAX_ROWS);
  const maxColumns = positiveLimit(options.maxColumns, DEFAULT_MAX_COLUMNS);
  const maxCellCharacters = positiveLimit(
    options.maxCellCharacters,
    DEFAULT_MAX_CELL_CHARACTERS,
  );
  const input = source.startsWith("\uFEFF") ? source.slice(1) : source;
  if (!input) return emptyPreview();

  const records: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  let cellWasTruncated = false;
  let truncatedRows = false;
  let truncatedColumns = false;
  let truncatedCells = false;

  const append = (value: string) => {
    if (cell.length < maxCellCharacters) {
      const remaining = maxCellCharacters - cell.length;
      cell += value.slice(0, remaining);
      if (value.length > remaining) cellWasTruncated = true;
    } else if (value) {
      cellWasTruncated = true;
    }
  };

  const finishCell = () => {
    const value = cellWasTruncated ? `${cell}…` : cell;
    if (row.length < maxColumns) row.push(value);
    else truncatedColumns = true;
    truncatedCells ||= cellWasTruncated;
    cell = "";
    cellWasTruncated = false;
  };

  const finishRow = (): boolean => {
    finishCell();
    // Keep one header record plus the requested number of data records.
    if (records.length < maxRows + 1) records.push(row);
    else truncatedRows = true;
    row = [];
    return truncatedRows;
  };

  let endedWithRecordBreak = false;
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    endedWithRecordBreak = false;

    if (character === '"') {
      if (inQuotes && input[index + 1] === '"') {
        append('"');
        index += 1;
      } else if (inQuotes) {
        inQuotes = false;
      } else if (!cell) {
        inQuotes = true;
      } else {
        append(character);
      }
      continue;
    }

    if (character === "\r" || character === "\n") {
      if (character === "\r" && input[index + 1] === "\n") index += 1;
      if (inQuotes) {
        append("\n");
      } else {
        endedWithRecordBreak = true;
        if (finishRow()) break;
      }
      continue;
    }

    if (character === "," && !inQuotes) {
      finishCell();
      continue;
    }

    append(character);
  }

  if (!truncatedRows && !endedWithRecordBreak) finishRow();
  if (records.length === 0) return emptyPreview();

  const headerRecord = records[0];
  const dataRows = records.slice(1);
  const columnCount = Math.max(
    headerRecord.length,
    ...dataRows.map((record) => record.length),
  );
  const headers = Array.from({ length: columnCount }, (_, index) =>
    headerRecord[index] ?? "",
  );

  return {
    headers,
    rows: dataRows,
    columnCount,
    truncatedRows,
    truncatedColumns,
    truncatedCells,
  };
}

function positiveLimit(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && Number(value) > 0
    ? Math.floor(Number(value))
    : fallback;
}

function emptyPreview(): CsvPreviewData {
  return {
    headers: [],
    rows: [],
    columnCount: 0,
    truncatedRows: false,
    truncatedColumns: false,
    truncatedCells: false,
  };
}
