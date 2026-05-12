export function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = "";
  let i = 0;
  let inQ = false;
  while (i < text.length) {
    const c = text[i];
    const n = text[i + 1];
    if (inQ) {
      if (c === '"' && n === '"') {
        field += '"';
        i += 2;
        continue;
      }
      if (c === '"') {
        inQ = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"') {
      inQ = true;
      i++;
      continue;
    }
    if (c === ",") {
      row.push(field);
      field = "";
      i++;
      continue;
    }
    if (c === "\r") {
      i++;
      continue;
    }
    if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i++;
      continue;
    }
    field += c;
    i++;
  }
  row.push(field);
  if (row.length > 1 || (row.length === 1 && row[0] !== "")) {
    rows.push(row);
  }
  return rows;
}

export function looksLikeHtmlDocument(text) {
  const normalized = String(text ?? "").trimStart().toLowerCase();
  return /^(<!doctype html|<html|<head|<body)/.test(normalized);
}

function normalizeCell(s) {
  return String(s ?? "").replace(/\s+/g, " ").trim();
}

function canonicalizeReasonCell(s) {
  const t = normalizeCell(s);
  if (!t.includes(",")) return t;
  const parts = t
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length <= 1) return t;
  parts.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  return parts.join(", ");
}

/**
 * Drop duplicate data rows (same MSISDN + error + reason + details + score after normalize).
 * Matches scripts/build_error_report.py semantic dedupe so the table does not show pairs.
 */
export function dedupeCsvMatrix(matrix) {
  if (!Array.isArray(matrix) || matrix.length < 2) return matrix;
  const headers = matrix[0].map((h) => String(h ?? ""));
  const n = headers.length;
  const reasonIdx = headers.findIndex((h) => h.toLowerCase() === "reason");
  const seen = new Set();
  const out = [matrix[0]];
  for (let r = 1; r < matrix.length; r++) {
    const row = matrix[r] || [];
    const keyParts = [];
    for (let c = 0; c < n; c++) {
      const cell = row[c] ?? "";
      keyParts.push(
        c === reasonIdx ? canonicalizeReasonCell(cell) : normalizeCell(cell)
      );
    }
    const key = keyParts.join("\u0001");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

/** At least one non-empty data row (row 1+) after the header. */
export function hasCsvDataRows(matrix) {
  if (!Array.isArray(matrix) || matrix.length < 2) return false;
  for (let r = 1; r < matrix.length; r++) {
    const row = matrix[r];
    if (!row) continue;
    for (const cell of row) {
      if (String(cell ?? "").trim() !== "") return true;
    }
  }
  return false;
}

/** Extra table column: 1st / 2nd / … row for the same SessionID (display order). */
export const SESSION_ROW_NUM_HEADER = "sessionid number";

/**
 * Per-row index (1, 2, …) for rows that share the same trimmed sessionid, in table order.
 * Empty sessionid: `#` column left blank for that row.
 * @param {string[][]} matrix - CSV matrix with header in row 0
 * @returns {{ seqByRow: (number|string)[], sessionColIndex: number }}
 * seqByRow[r] is set for r >= 1.
 */
export function computeSessionSequenceMeta(matrix) {
  const empty = { seqByRow: [], sessionColIndex: -1 };
  if (!Array.isArray(matrix) || matrix.length < 2) return empty;

  const sessionColIndex = matrix[0].map((h) => String(h)).findIndex((h) => h.toLowerCase() === "sessionid");
  const seqByRow = new Array(matrix.length).fill("");
  if (sessionColIndex === -1) return { seqByRow, sessionColIndex: -1 };

  const seen = new Map();
  for (let r = 1; r < matrix.length; r++) {
    const sid = String(matrix[r][sessionColIndex] ?? "").trim();
    if (sid) {
      const next = (seen.get(sid) || 0) + 1;
      seen.set(sid, next);
      seqByRow[r] = next;
    }
  }
  return { seqByRow, sessionColIndex };
}

function escapeForCsvField(s) {
  s = String(s ?? "");
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function matrixToCsvString(matrix) {
  return matrix
    .map((row) => row.map((cell) => escapeForCsvField(cell)).join(","))
    .join("\r\n");
}

export function reportDownloadName() {
  if (typeof window !== "undefined" && window.REPORT_CSV_NAME) {
    return window.REPORT_CSV_NAME;
  }
  return "my_error_report.csv";
}

export function downloadBlobAsFile(blob, filename) {
  const u = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = u;
  a.setAttribute("download", filename);
  a.click();
  URL.revokeObjectURL(u);
}
