import { useCallback, useEffect, useState, useMemo, useRef } from "react";
import {
  computeSessionSequenceMeta,
  dedupeCsvMatrix,
  downloadBlobAsFile,
  hasCsvDataRows,
  looksLikeHtmlDocument,
  parseCSV,
} from "../csvUtils.js";

import { analyzeReportRows } from "../reportAnalysis.js";
import {
  saveUpload,
  getUploadById,
  getUploads,
  deleteUpload,
  formatFileSize,
  MAX_FILE_SIZE_WARNING,
  CHUNK_SIZE,
} from "../indexedDB.js";
import { MdDelete, MdOutlineSearch } from "react-icons/md";
import { HiOutlineChartBar } from "react-icons/hi";
import * as XLSX from "xlsx";
import FailureAnalysisModal from "./FailureAnalysisModal.jsx";
import "../styles/ErrorReport.css";

const SEARCH_DEBOUNCE_MS = 300;
const VIRTUAL_ROW_HEIGHT = 52;
const VIRTUAL_ROW_BUFFER = 60;
const RUN_FILE_BATCH_SIZE = Number(import.meta.env.VITE_RUN_FILE_BATCH_SIZE) || 8;
const RUN_SUCCESS_MESSAGE_MS = 4000;

function reportCacheKey(pageKey) {
  return `${pageKey}_last_report_matrix`;
}

function newUploadId() {
  if (crypto?.randomUUID) return crypto.randomUUID();
  return `u-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function normalizeQuery(s) {
  return String(s ?? "").trim().toLowerCase();
}

function formatDateCell(value) {
  let raw = String(value ?? "").trim();
  if (raw.startsWith("'")) raw = raw.replace(/^'+|'+$/g, "").trim();
  if (!raw) return "";
  const m = raw.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.(\d+))?(?:Z|[+-]\d{2}:?\d{2})?$/);
  if (!m) return raw;
  const frac = (m[3] || "00").padEnd(2, "0").slice(0, 2);
  return `${m[1]} ${m[2]}.${frac}`;
}

function buildDisplayColumns(headers) {
  const lower = headers.map((h) => h.toLowerCase());
  const detailsIndex = lower.indexOf("details");
  const used = new Set();
  const columns = [];

  const msisdnIndex = lower.indexOf("msisdn");
  if (msisdnIndex !== -1) {
    used.add(msisdnIndex);
    columns.push({ key: "msisdn", label: "msisdn", sourceIndex: msisdnIndex });
  }

  const sessionIndex = lower.findIndex((h) => h === "sessionid" || h === "session id");
  if (sessionIndex !== -1) {
    used.add(sessionIndex);
    columns.push({ key: "sessionid", label: "session id", sourceIndex: sessionIndex });
    columns.push({ key: "sessionid-num", label: "attempt no", virtual: "session-seq" });

    // Derived scoring columns (from `details` text).
    if (detailsIndex !== -1) {
      const hasShortfallHeader = lower.some((h) => h.trim().toLowerCase() === "shortfall");
      const hasActualScoreHeader = lower.some((h) => h.trim().toLowerCase() === "actual score");
      const hasRequiredAgeHeader = lower.some((h) => h.trim().toLowerCase() === "required age");
      const hasOnDocumentAgeHeader = lower.some((h) => h.trim().toLowerCase() === "on document");
      const hasVarianceHeader = lower.some((h) => h.trim().toLowerCase() === "variance");

      // Only add virtual/derived columns if the CSV doesn't already provide them.
      if (!hasShortfallHeader) {
        columns.push({
          key: "shortfall",
          label: "shortfall",
          virtual: "derived-shortfall",
          sourceIndex: detailsIndex,
        });
      }
      if (!hasActualScoreHeader) {
        columns.push({
          key: "actual-score",
          label: "actual score",
          virtual: "derived-actual-score",
          sourceIndex: detailsIndex,
        });
      }
      if (!hasRequiredAgeHeader) {
        columns.push({
          key: "required-age",
          label: "required age",
          virtual: "derived-required-age",
          sourceIndex: detailsIndex,
        });
      }
      if (!hasOnDocumentAgeHeader) {
        columns.push({
          key: "on-document",
          label: "on document",
          virtual: "derived-on-document",
          sourceIndex: detailsIndex,
        });
      }
      if (!hasVarianceHeader) {
        columns.push({
          key: "variance",
          label: "variance",
          virtual: "derived-variance",
          sourceIndex: detailsIndex,
        });
      }
    }
  }

  const dateIndex = lower.findIndex((h) =>
    ["date", "time", "timestamp", "time_stamp"].includes(h)
  );
  if (dateIndex !== -1) {
    used.add(dateIndex);
    columns.push({ key: "date", label: "date", sourceIndex: dateIndex, format: "date" });
  }

  const errorCodeIndex = lower.findIndex((h) => h === "errorcode" || h === "error code");
  if (errorCodeIndex !== -1) {
    used.add(errorCodeIndex);
    columns.push({ key: "errorcode", label: "errorcode", sourceIndex: errorCodeIndex });
  }

  // Handle failureReason and validationType (with parsing support for packed strings)
  const reasonIndex = lower.findIndex((h) => h === "reason" || h === "failurereason" || h === "failure reason");
  const validationIndex = lower.findIndex((h) => h === "validationtype" || h === "validation type");

  if (reasonIndex !== -1) {
    used.add(reasonIndex);
    columns.push({
      key: "failureReason",
      label: "failureReason",
      sourceIndex: reasonIndex,
      parsePart: "failureReason",
    });

    // If validationType is not a separate column, try to parse it from the reason column
    if (validationIndex === -1) {
      columns.push({
        key: "validationType",
        label: "validationType",
        sourceIndex: reasonIndex,
        parsePart: "validationType",
      });
    }
  }

  if (validationIndex !== -1) {
    used.add(validationIndex);
    columns.push({ key: "validationType", label: "validationType", sourceIndex: validationIndex });
  }

  if (detailsIndex !== -1) {
    used.add(detailsIndex);
  }

  headers.forEach((header, idx) => {
    if (used.has(idx)) return;
    columns.push({ key: `col-${idx}-${header}`, label: header, sourceIndex: idx });
  });

  let ordered = reorderAgeColumnsAfterScoreThreshold(columns);
  if (detailsIndex !== -1) {
    const detailsCol = {
      key: `col-${detailsIndex}-${headers[detailsIndex]}`,
      label: headers[detailsIndex],
      sourceIndex: detailsIndex,
    };
    ordered = ordered.filter((c) => !(c.sourceIndex === detailsIndex && !c.virtual));
    ordered.push(detailsCol);
  }
  return ordered;
}

function reorderAgeColumnsAfterScoreThreshold(columns) {
  const ageLabels = new Set(["required age", "on document", "variance"]);
  const ageColumns = columns.filter((c) => ageLabels.has(String(c?.label ?? "").toLowerCase()));
  if (!ageColumns.length) return columns;

  const baseColumns = columns.filter((c) => !ageLabels.has(String(c?.label ?? "").toLowerCase()));
  const scoreThresholdIndex = baseColumns.findIndex((c) => {
    const label = String(c?.label ?? "").toLowerCase();
    return label.includes("scorethreshold") || label.includes("score threshold");
  });

  if (scoreThresholdIndex === -1) {
    return [...baseColumns, ...ageColumns];
  }

  return [
    ...baseColumns.slice(0, scoreThresholdIndex + 1),
    ...ageColumns,
    ...baseColumns.slice(scoreThresholdIndex + 1),
  ];
}

function displayCellValue(column, row, seq) {
  if (column.virtual === "session-seq") return String(seq ?? "");

  if (column.virtual === "derived-shortfall") {
    return parseShortfallFromDetails(row?.[column.sourceIndex]);
  }

  if (column.virtual === "derived-actual-score") {
    return parseActualScoreFromDetails(row?.[column.sourceIndex]);
  }

  if (column.virtual === "derived-required-age") {
    return parseAgeFieldsFromDetails(row?.[column.sourceIndex]).requiredAge;
  }

  if (column.virtual === "derived-on-document") {
    return parseAgeFieldsFromDetails(row?.[column.sourceIndex]).onDocument;
  }

  if (column.virtual === "derived-variance") {
    return parseAgeFieldsFromDetails(row?.[column.sourceIndex]).variance;
  }

  const raw = row?.[column.sourceIndex];
  let value = raw != null ? String(raw) : "";

  // Handle parsing packed fields like "failureReason=X, validationType=Y"
  if (column.parsePart && value.includes("=")) {
    const parts = value.split(",").map((p) => p.trim());
    const found = parts.find((p) => p.startsWith(`${column.parsePart}=`));
    if (found) {
      value = found.split("=")[1] || "";
    } else if (column.parsePart === "validationType") {
      // If we are looking for validationType but it's not in the packed string, return empty
      value = "";
    }
  }

  const labelLower = String(column?.label ?? "").toLowerCase();
  if (labelLower.includes("scorethreshold") || labelLower.includes("score threshold")) {
    if (rowLooksLikeAgeValidation(row)) return "";
    value = stripAgeFromScoreThreshold(value);
    value = extractThresholdValue(value);
  }

  if (column.format === "date") return formatDateCell(value);
  return value;
}

function parseActualScoreFromDetails(detailsText) {
  const s = String(detailsText ?? "");
  // Example: "Log values: actual score 0.1203999966; min required 0.7; ..."
  const m = s.match(/\bactual score\s*([+-]?\d+(?:\.\d+)?)/i);
  return m ? m[1] : "";
}

function parseShortfallFromDetails(detailsText) {
  const s = String(detailsText ?? "");
  // Example: "...; shortfall -0.5796000034; check: ..."
  const m = s.match(/\bshortfall\s*([+-]?\d+(?:\.\d+)?)/i);
  return m ? m[1] : "";
}

function parseAgeFieldsFromDetails(detailsText) {
  const s = String(detailsText ?? "");
  const minMatch = s.match(/\bmin age required\s*([+-]?\d+(?:\.\d+)?)/i);
  const maxMatch = s.match(/\bmax age cap\s*([+-]?\d+(?:\.\d+)?)/i);
  const onDocMatch = s.match(/\bage on document\s*([+-]?\d+(?:\.\d+)?)/i);
  const belowByMatch = s.match(/\bbelow by\s*([+-]?\d+(?:\.\d+)?)/i);
  const aboveByMatch = s.match(/\babove by\s*([+-]?\d+(?:\.\d+)?)/i);

  const min = minMatch ? minMatch[1] : "";
  const max = maxMatch ? maxMatch[1] : "";
  const onDocument = onDocMatch ? onDocMatch[1] : "";
  const requiredAge = min && max ? `${min}-${max}` : "";
  const variance = belowByMatch ? belowByMatch[1] : aboveByMatch ? aboveByMatch[1] : "";

  return { requiredAge, onDocument, variance };
}

function rowLooksLikeAgeValidation(row) {
  if (!Array.isArray(row)) return false;
  const joined = row.map((v) => String(v ?? "")).join(" ").toLowerCase();
  return (
    joined.includes("age on document") ||
    joined.includes("min age required") ||
    joined.includes("max age cap") ||
    joined.includes("below by") ||
    joined.includes("above by")
  );
}

function stripAgeFromScoreThreshold(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";

  const kept = raw
    .split(/[;,|]/)
    .map((p) => p.trim())
    .filter(Boolean)
    .filter((p) => !/\bage\b/i.test(p));

  if (kept.length) return kept.join("; ");

  return raw
    .replace(/\bage\s*group\s*[:=]?\s*[\w.-]+/gi, "")
    .replace(/\bage on document\s*[:=]?\s*[\w.-]+/gi, "")
    .replace(/\bmin age required\s*[:=]?\s*[\w.-]+/gi, "")
    .replace(/\bmax age cap\s*[:=]?\s*[\w.-]+/gi, "")
    .replace(/\bage\s*[:=]?\s*[\w.-]+/gi, "")
    .replace(/\s{2,}/g, " ")
    .replace(/^[,;|\s]+|[,;|\s]+$/g, "")
    .trim();
}

function extractThresholdValue(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";

  // Example input: "0.0081000002 / 0.7" -> "0.7"
  if (raw.includes("/")) {
    const right = raw.split("/").pop()?.trim() || "";
    const n = right.match(/[+-]?\d+(?:\.\d+)?/);
    return n ? n[0] : right;
  }

  return raw;
}

function excelFileName(name) {
  const base = (name || "my_error_report.csv").trim();
  if (/\.csv$/i.test(base)) return base.replace(/\.csv$/i, ".xlsx");
  return /\.xlsx$/i.test(base) ? base : `${base}.xlsx`;
}

function findScoreColumnIndex(headers) {
  const h = (headers || []).map((x) => String(x ?? ""));
  const lower = h.map((x) => x.trim().toLowerCase());

  const candidates = lower
    .map((name, idx) => ({ idx, name }))
    .filter(({ name }) => name && name.includes("score"));

  if (!candidates.length) return -1;

  const rank = (name) => {
    if (name === "score") return 0;
    if (name === "livenessscore" || name === "liveness score") return 1;
    if (name.includes("liveness") && name.includes("score")) return 2;
    if (name.includes("match") && name.includes("score")) return 3;
    if (name.includes("similar") && name.includes("score")) return 4;
    if (name.includes("scorethreshold") || name.includes("score threshold")) return 9;
    return 5;
  };

  candidates.sort((a, b) => rank(a.name) - rank(b.name));
  return candidates[0]?.idx ?? -1;
}

function parseScoreValue(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  const n = Number(s);
  if (Number.isFinite(n)) return n;
  const m = s.match(/-?\d+(\.\d+)?/);
  if (!m) return null;
  const n2 = Number(m[0]);
  return Number.isFinite(n2) ? n2 : null;
}

function buildScoreDistribution(headers, dataRows) {
  const idx = findScoreColumnIndex(headers);
  if (idx === -1) {
    return { ok: false, reason: "No score column found in this CSV.", buckets: [] };
  }

  const values = [];
  for (const r of dataRows || []) {
    const v = parseScoreValue(r?.[idx]);
    if (v == null) continue;
    values.push(v);
  }

  if (!values.length) {
    return { ok: false, reason: "Score column exists, but no numeric score values were found.", buckets: [] };
  }

  values.sort((a, b) => a - b);
  const total = values.length;

  // Force 0.0 to 0.7 range with 0.1 increments as requested by user (removing last 3 success buckets)
  const bucketCount = 7;
  const start = 0;
  const step = 0.1;

  const rawBuckets = [];
  for (let i = 0; i < bucketCount; i++) {
    const a = start + step * i;
    const b = start + step * (i + 1);
    rawBuckets.push({ from: a, to: b, count: 0 });
  }

  for (const v of values) {
    let i = Math.floor((v - start) / step);
    // Only count values that fall within our 7 buckets (0.0 to 0.7)
    if (i >= 0 && i < bucketCount) {
      rawBuckets[i].count++;
    }
  }

  const fmt = (n, digits) => Number(n).toFixed(digits);
  const fmtPct = (n) => (total ? (Math.round((n / total) * 1000) / 10).toFixed(1) : "0.0");
  const fmtRange = (a, b) => `${fmt(a, 1)} - ${fmt(b, 1)}`;

  // values are already sorted, so threshold split can be found in O(log n)
  const firstAboveOrEqual = values.findIndex((v) => v >= 0.7);
  const belowThreshold = firstAboveOrEqual === -1 ? total : firstAboveOrEqual;
  const aboveThreshold = total - belowThreshold;

  return {
    ok: true,
    reason: null,
    threshold: 0.7,
    summary: {
      below: { count: belowThreshold, pct: `${fmtPct(belowThreshold)}%` },
      above: { count: aboveThreshold, pct: `${fmtPct(aboveThreshold)}%` },
    },
    buckets: rawBuckets.map((x) => ({
      range: fmtRange(x.from, x.to),
      from: x.from,
      to: x.to,
      count: x.count,
      pct: `${fmtPct(x.count)}%`,
      isBelowThreshold: true, // All shown buckets are now below threshold
    })),
  };
}

function buildAgeDistribution(headers, dataRows) {
  const h = (headers || []).map((x) => String(x ?? "").trim().toLowerCase());
  const detailsIndex = h.indexOf("details");
  const onDocumentIndex = h.findIndex((x) => x === "on document" || x === "age on document");
  const counts = new Map();

  for (const row of dataRows || []) {
    let ageValue = "";
    if (onDocumentIndex !== -1) {
      ageValue = String(row?.[onDocumentIndex] ?? "").trim();
    }
    if (!ageValue && detailsIndex !== -1) {
      ageValue = parseAgeFieldsFromDetails(row?.[detailsIndex]).onDocument;
    }
    if (!ageValue) continue;
    const m = String(ageValue).match(/\b(\d{1,3})\b/);
    if (!m) continue;
    const age = Number(m[1]);
    if (!Number.isFinite(age)) continue;
    if (age < 1) continue;
    counts.set(age, (counts.get(age) || 0) + 1);
  }

  const total = Array.from(counts.values()).reduce((a, b) => a + b, 0);
  if (!total) {
    return { ok: false, reason: "No age values found for distribution.", total: 0, buckets: [] };
  }

  const rawBuckets = [];
  rawBuckets.push({ from: 1, to: 9, count: 0, label: "1 - 9" });
  rawBuckets.push({ from: 10, to: 18, count: 0, label: "10 - 18" });
  rawBuckets.push({ from: 121, to: Number.POSITIVE_INFINITY, count: 0, label: "Above 120" });

  for (const [age, count] of counts.entries()) {
    const bucket = rawBuckets.find((b) => age >= b.from && age <= b.to);
    if (bucket) bucket.count += count;
  }

  const fmtPct = (n) => (total ? (Math.round((n / total) * 1000) / 10).toFixed(1) : "0.0");

  return {
    ok: true,
    reason: null,
    summary: { total: { count: total, pct: "100.0%" } },
    threshold: null,
    buckets: rawBuckets.map((b) => ({
      range: b.label,
      from: b.from,
      to: b.to,
      count: b.count,
      pct: `${fmtPct(b.count)}%`,
      isBelowThreshold: false,
    })),
  };
}

function buildAnalysisSheetRows(failureAnalysis, dataRowCount) {
  const rows = [
    ["Analysis", "Value"],
    ["Total rows", Number.isFinite(dataRowCount) ? dataRowCount : 0],
    ["Rows analyzed for pivot", failureAnalysis?.total ?? 0],
    [],
    ["Failure bucket", "Count", "Percent", "Hint"],
  ];
  if (failureAnalysis?.items?.length) {
    failureAnalysis.items.forEach((item) => {
      rows.push([item.label, item.count, `${item.pct}%`, item.hint || ""]);
    });
  } else {
    rows.push(["No analysis buckets found", 0, "0%", ""]);
  }
  return rows;
}

function buildScoreDistributionSheetRows(scoreDistribution) {
  const rows = [["Score Range", "Count", "Percentage"]];
  if (!scoreDistribution?.ok) {
    rows.push([scoreDistribution?.reason || "Score distribution unavailable", "", ""]);
    return rows;
  }
  if (scoreDistribution.summary?.below) {
    rows.push([
      `Total Failure (< ${scoreDistribution.threshold})`,
      scoreDistribution.summary.below.count ?? 0,
      scoreDistribution.summary.below.pct ?? "0.0%",
    ]);
    rows.push([]);
  }
  const buckets = Array.isArray(scoreDistribution.buckets) ? scoreDistribution.buckets : [];
  for (const bucket of buckets) {
    rows.push([bucket.range, bucket.count ?? 0, bucket.pct ?? "0.0%"]);
  }
  return rows;
}

function buildAgeDistributionSheetRows(ageDistribution) {
  const rows = [["Age Range", "Count", "Percentage"]];
  if (!ageDistribution?.ok) {
    rows.push([ageDistribution?.reason || "Age distribution unavailable", "", ""]);
    return rows;
  }
  const buckets = Array.isArray(ageDistribution.buckets) ? ageDistribution.buckets : [];
  for (const bucket of buckets) {
    rows.push([bucket.range, bucket.count ?? 0, bucket.pct ?? "0.0%"]);
  }
  return rows;
}

function appendSection(rows, title, sectionRows) {
  rows.push([]);
  rows.push([title]);
  rows.push([]);
  for (const r of sectionRows) rows.push(r);
  return rows;
}

function computeSheetCols(matrix, { maxCols = 6, minWch = 10, maxWch = 70 } = {}) {
  const cols = [];
  for (let c = 0; c < maxCols; c++) {
    let maxLen = 0;
    for (const row of matrix || []) {
      const v = row?.[c];
      if (v == null) continue;
      const s = String(v);
      if (s.length > maxLen) maxLen = s.length;
    }
    if (maxLen > 0) {
      cols.push({ wch: Math.max(minWch, Math.min(maxWch, maxLen + 2)) });
    }
  }
  return cols;
}

function createEmptySheet() {
  return XLSX.utils.aoa_to_sheet([[]]);
}

function pauseForUi() {
  return new Promise((resolve) => {
    if (window.requestAnimationFrame) {
      window.requestAnimationFrame(() => resolve());
    } else {
      setTimeout(resolve, 0);
    }
  });
}

async function appendMatrixInBatches(sheet, matrix, batchSize = 2000) {
  if (!Array.isArray(matrix) || !matrix.length) return;
  let firstWrite = true;
  for (let i = 0; i < matrix.length; i += batchSize) {
    const batch = matrix.slice(i, i + batchSize);
    XLSX.utils.sheet_add_aoa(sheet, batch, { origin: firstWrite ? "A1" : -1 });
    firstWrite = false;
    // Yield every few batches to keep browser responsive on large exports.
    if (i > 0 && Math.floor(i / batchSize) % 4 === 0) {
      await pauseForUi();
    }
  }
}

function buildRunRequestBodyBlob(files, msisdnFile, options = {}) {
  const parts = ['{"files": ['];
  files.forEach((f, i) => {
    if (i > 0) parts.push(",");
    parts.push(
      '{"name":',
      JSON.stringify(f.name ?? ""),
      ',"content":',
      JSON.stringify(f.text ?? ""),
      "}"
    );
  });
  parts.push('], "msisdnFile":');
  parts.push(msisdnFile ? JSON.stringify(msisdnFile) : "null");
  parts.push(', "returnReportCsv":');
  parts.push(options.returnReportCsv ? "true" : "false");
  parts.push("}");
  return new Blob(parts, { type: "application/json; charset=utf-8" });
}

function splitIntoBatches(list, batchSize) {
  const out = [];
  for (let i = 0; i < list.length; i += batchSize) {
    out.push(list.slice(i, i + batchSize));
  }
  return out;
}

function mergeReportMatrices(matrices, { dedupe = true } = {}) {
  if (!Array.isArray(matrices) || !matrices.length) return null;
  let header = null;
  const mergedRows = [];
  for (const matrix of matrices) {
    if (!Array.isArray(matrix) || matrix.length < 2) continue;
    if (!header) {
      header = matrix[0].map((h) => String(h ?? ""));
      mergedRows.push(header);
    }
    for (let i = 1; i < matrix.length; i++) {
      const row = Array.isArray(matrix[i]) ? matrix[i] : [];
      mergedRows.push(row.slice(0, header.length));
    }
  }
  if (!header || mergedRows.length < 2) return null;
  return dedupe ? dedupeCsvMatrix(mergedRows) : mergedRows;
}

function sortKeySession(value) {
  return String(value ?? "").trim().toLowerCase();
}

export default function ErrorReport({
  enableFailureAnalysis = true,
  enableMsisdnFilterUpload = false,
  errorsOnly = false,
  compactTable = false,
  reportCsvName = "",
} = {}) {
  const [reportData, setReportData] = useState(null);
  const [showTable, setShowTable] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState("");
  const [uploads, setUploads] = useState([]);
  const [selectedUploadId, setSelectedUploadId] = useState("");
  const [mergeAll, setMergeAll] = useState(false);
  const [running, setRunning] = useState(false);
  const [runMessage, setRunMessage] = useState(null);
  const [showAnalysisModal, setShowAnalysisModal] = useState(false);
  const [msisdnFilter, setMsisdnFilter] = useState(null);
  const [msisdnFilterLoading, setMsisdnFilterLoading] = useState(false);
  const [fileLoading, setFileLoading] = useState(null);
  const [tableScrollTop, setTableScrollTop] = useState(0);
  const [tableViewportHeight, setTableViewportHeight] = useState(520);
  const tableWrapRef = useRef(null);
  const scrollRafRef = useRef(null);
  const pendingScrollTopRef = useRef(0);
  const runSuccessTimerRef = useRef(null);
  const csvName = reportCsvName || "my_error_report.csv";
  const pageKey = enableMsisdnFilterUpload ? "msisdn_uploads" : "daily_uploads";

  useEffect(() => {
    try {
      const raw = localStorage.getItem(reportCacheKey(pageKey));
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed) || parsed.length < 2) return;
      if (!Array.isArray(parsed[0])) return;
      setReportData(parsed);
      setShowTable(true);
    } catch {
      // Ignore bad cache and continue with normal flow.
    }
  }, [pageKey]);

  function readFileInChunks(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      const chunks = [];
      let offset = 0;

      reader.onload = (e) => {
        if (e.target.result) {
          chunks.push(e.target.result);
        }
        offset += CHUNK_SIZE;

        if (offset < file.size) {
          setFileLoading(`Reading ${file.name}... ${Math.round((offset / file.size) * 100)}%`);
          const slice = file.slice(offset, offset + CHUNK_SIZE);
          reader.readAsText(slice, "UTF-8");
        } else {
          const fullText = chunks.join("");
          setFileLoading(null);
          resolve(fullText);
        }
      };

      reader.onerror = () => {
        setFileLoading(null);
        reject(reader.error);
      };

      const firstSlice = file.slice(offset, offset + CHUNK_SIZE);
      reader.readAsText(firstSlice, "UTF-8");
    });
  }

  const uploadTextById = useCallback(async (uploadId) => {
    const record = await getUploadById(uploadId);
    if (!record || typeof record.text !== "string") return "";
    return record.text;
  }, []);

  const handleTableScroll = useCallback((e) => {
    pendingScrollTopRef.current = e.currentTarget.scrollTop;
    if (scrollRafRef.current != null) return;
    scrollRafRef.current = window.requestAnimationFrame(() => {
      scrollRafRef.current = null;
      setTableScrollTop(pendingScrollTopRef.current);
    });
  }, []);

  const tableView = useMemo(() => {
    if (!reportData || !reportData.length) return null;
    const headers = reportData[0].map((h) => String(h));
    const hLower = headers.map((h) => h.toLowerCase());
    const displayColumns = buildDisplayColumns(headers);
    const msisdnIndex = hLower.indexOf("msisdn");
    const sessionidIndex = hLower.indexOf("sessionid");
    const errorCodeIndex = hLower.indexOf("errorcode");
    const meta = computeSessionSequenceMeta(reportData);
    const query = normalizeQuery(debouncedSearchQuery);
    const rows = [];
    for (let r = 1; r < reportData.length; r++) {
      const row = reportData[r];
      if (errorsOnly && errorCodeIndex !== -1) {
        const code = String(row?.[errorCodeIndex] ?? "").trim();
        if (!code) continue;
      }
      if (query) {
        const matchMsisdn =
          msisdnIndex !== -1 && String(row[msisdnIndex] ?? "").toLowerCase().includes(query);
        const matchSessionid =
          sessionidIndex !== -1 &&
          String(row[sessionidIndex] ?? "").toLowerCase().includes(query);
        if (!matchMsisdn && !matchSessionid) continue;
      }
      rows.push({ origIndex: r, row });
    }
    if (sessionidIndex !== -1 || msisdnIndex !== -1) {
      rows.sort((a, b) => {
        const seqA = Number(meta.seqByRow[a.origIndex] ?? 0);
        const seqB = Number(meta.seqByRow[b.origIndex] ?? 0);
        if (seqA !== seqB) return seqA - seqB;

        const msisdnA = sortKeySession(a.row?.[msisdnIndex]);
        const msisdnB = sortKeySession(b.row?.[msisdnIndex]);
        if (!msisdnA && msisdnB) return 1;
        if (msisdnA && !msisdnB) return -1;
        if (msisdnA !== msisdnB) return msisdnA.localeCompare(msisdnB);

        const sidA = sortKeySession(a.row?.[sessionidIndex]);
        const sidB = sortKeySession(b.row?.[sessionidIndex]);
        if (!sidA && sidB) return 1;
        if (sidA && !sidB) return -1;
        if (sidA !== sidB) return sidA.localeCompare(sidB);
        return 0;
      });
    }
    return { headers, displayColumns, rows, meta };
  }, [reportData, debouncedSearchQuery, errorsOnly]);

  const virtualRows = useMemo(() => {
    if (!tableView?.rows?.length) {
      return { start: 0, end: 0, topPad: 0, bottomPad: 0, rows: [] };
    }
    const total = tableView.rows.length;
    const visibleCount = Math.ceil(tableViewportHeight / VIRTUAL_ROW_HEIGHT) + VIRTUAL_ROW_BUFFER * 2;
    const start = Math.max(0, Math.floor(tableScrollTop / VIRTUAL_ROW_HEIGHT) - VIRTUAL_ROW_BUFFER);
    const end = Math.min(total, start + visibleCount);
    return {
      start,
      end,
      topPad: start * VIRTUAL_ROW_HEIGHT,
      bottomPad: Math.max(0, (total - end) * VIRTUAL_ROW_HEIGHT),
      rows: tableView.rows.slice(start, end),
    };
  }, [tableView, tableScrollTop, tableViewportHeight]);

  const downloadMatrix = useMemo(() => {
    if (!tableView) return null;
    const { displayColumns, rows, meta } = tableView;
    const head = displayColumns.map((c) => c.label);
    const body = rows.map(({ origIndex, row }) => {
      const seq = meta.seqByRow[origIndex] ?? "";
      return displayColumns.map((col) => displayCellValue(col, row, seq));
    });
    return [head, ...body];
  }, [tableView]);

  const failureAnalysis = useMemo(() => {
    if (!enableFailureAnalysis) return null;
    if (!tableView?.headers?.length || !tableView.rows?.length) return null;
    const dataRows = tableView.rows.map(({ row }) => row);
    return analyzeReportRows(tableView.headers, dataRows);
  }, [tableView, enableFailureAnalysis]);

  const scoreDistribution = useMemo(() => {
    if (!tableView?.headers?.length || !tableView.rows?.length) return null;
    const dataRows = tableView.rows.map(({ row }) => row);
    return buildScoreDistribution(tableView.headers, dataRows);
  }, [tableView]);

  const ageDistribution = useMemo(() => {
    if (!tableView?.headers?.length || !tableView.rows?.length) return null;
    const dataRows = tableView.rows.map(({ row }) => row);
    return buildAgeDistribution(tableView.headers, dataRows);
  }, [tableView]);

  const applyMatrix = useCallback((matrix) => {
    if (!hasCsvDataRows(matrix)) {
      setShowTable(false);
      setReportData(null);
      return;
    }
    setReportData(matrix);
    setShowTable(true);
  }, []);

  const loadFromText = useCallback(
    (text, { skipDedupe = false } = {}) => {
      if (looksLikeHtmlDocument(text)) {
        setShowTable(false);
        setReportData(null);
        return false;
      }
      const parsed = parseCSV(text);
      const matrix = skipDedupe ? parsed : dedupeCsvMatrix(parsed);
      const hasRows = hasCsvDataRows(matrix);
      applyMatrix(matrix);
      return hasRows;
    },
    [applyMatrix]
  );

  const loadReportFromUrl = useCallback(async () => {
    if (window?.location?.protocol === "file:") {
      setShowTable(false);
      setReportData(null);
      return false;
    }
    try {
      const res = await fetch(`${csvName}?t=${Date.now()}`, { cache: "no-store" });
      if (!res.ok) return false;
      const text = await res.text();
      return loadFromText(text);
    } catch {
      return false;
    }
  }, [loadFromText, csvName]);

  const onLogFilesSelected = async (ev) => {
    const list = Array.from(ev.target.files || []);
    if (!list.length) return;

    const csvFiles = list.filter((f) => f.name.toLowerCase().endsWith(".csv"));
    if (!csvFiles.length) {
      setRunMessage({ type: "err", text: "No CSV files found in selection." });
      return;
    }

    const items = [];
    for (const f of csvFiles) {
      if (f.size > MAX_FILE_SIZE_WARNING) {
        setRunMessage({
          type: "err",
          text: `File "${f.name}" is very large (${formatFileSize(f.size)}). This may take a moment...`,
        });
      }

      try {
        setFileLoading(`Reading ${f.name}...`);
        const text = await readFileInChunks(f);
        const id = newUploadId();
        await saveUpload({ id, name: f.name, text }, pageKey);
        items.push({ id, name: f.name, size: text.length, savedAt: Date.now() });
      } catch (err) {
        setRunMessage({ type: "err", text: `Could not read file: ${f.name}` });
        setFileLoading(null);
        return;
      }
    }

    setUploads((prev) => [...prev, ...items]);
    setSelectedUploadId((prevSel) => prevSel || items[0].id);
    setFileLoading(null);
    setRunMessage({ type: "ok", text: `Loaded ${items.length} file(s).` });
    ev.target.value = "";
  };

  const onMsisdnFileSelected = (ev) => {
    const f = ev.target.files?.[0];
    ev.target.value = "";
    if (!f) return;
    setMsisdnFilterLoading(true);
    // Keep filename immediately so user can confirm selection in UI.
    setMsisdnFilter({ name: f.name, text: "" });
    const reader = new FileReader();
    reader.onload = () => {
      setMsisdnFilter({ name: f.name, text: String(reader.result ?? "") });
      setMsisdnFilterLoading(false);
      setRunMessage(null);
    };
    reader.onerror = () => {
      setMsisdnFilterLoading(false);
      setMsisdnFilter(null);
      setRunMessage({ type: "err", text: "Could not read MSISDN file." });
    };
    reader.readAsText(f, "UTF-8");
  };

  const removeUpload = (id) => {
    setUploads((prev) => prev.filter((u) => u.id !== id));
    deleteUpload(id, pageKey);
  };

  useEffect(() => {
    async function loadFromDB() {
      try {
        const savedUploads = await getUploads(pageKey);
        if (savedUploads.length > 0) {
          const uploadMeta = savedUploads.map(({ id, name, size, savedAt }) => ({
            id,
            name,
            size: Number(size || 0),
            savedAt,
          }));
          setUploads(uploadMeta);
          if (savedUploads.length > 1) {
            setMergeAll(true);
          }
        }
      } catch (e) {
        console.error("Failed to load uploads from IndexedDB:", e);
      }
    }
    loadFromDB();
  }, [pageKey]);

  useEffect(() => {
    if (uploads.length <= 1) {
      setMergeAll(false);
    }
  }, [uploads.length]);

  useEffect(() => {
    try {
      if (showTable && Array.isArray(reportData) && reportData.length > 1) {
        localStorage.setItem(reportCacheKey(pageKey), JSON.stringify(reportData));
      } else {
        localStorage.removeItem(reportCacheKey(pageKey));
      }
    } catch {
      // Ignore storage errors (private mode / storage limits).
    }
  }, [reportData, showTable, pageKey]);

  useEffect(() => {
    if (!uploads.length) return;
    if (mergeAll) return;
    if (!uploads.some((u) => u.id === selectedUploadId)) {
      setSelectedUploadId(uploads[0].id);
    }
  }, [uploads, selectedUploadId, mergeAll]);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearchQuery(searchQuery), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [searchQuery]);

  useEffect(() => {
    setTableScrollTop(0);
    if (tableWrapRef.current) tableWrapRef.current.scrollTop = 0;
  }, [debouncedSearchQuery, reportData]);

  useEffect(() => {
    const updateViewport = () => {
      if (!tableWrapRef.current) return;
      setTableViewportHeight(Math.max(260, tableWrapRef.current.clientHeight || 520));
    };
    updateViewport();
    window.addEventListener("resize", updateViewport);
    return () => window.removeEventListener("resize", updateViewport);
  }, [showTable, reportData]);

  useEffect(() => {
    if (runSuccessTimerRef.current) {
      clearTimeout(runSuccessTimerRef.current);
      runSuccessTimerRef.current = null;
    }
    if (runMessage?.type === "ok" && runMessage?.text === "Run Successfully") {
      runSuccessTimerRef.current = setTimeout(() => {
        setRunMessage((current) =>
          current?.type === "ok" && current?.text === "Run Successfully" ? null : current
        );
        runSuccessTimerRef.current = null;
      }, RUN_SUCCESS_MESSAGE_MS);
    }
    return () => {
      if (runSuccessTimerRef.current) {
        clearTimeout(runSuccessTimerRef.current);
        runSuccessTimerRef.current = null;
      }
    };
  }, [runMessage]);

  const filesForRun = useMemo(() => {
    if (!uploads.length) return [];
    if (mergeAll && uploads.length > 1) return uploads;
    const one = uploads.find((u) => u.id === selectedUploadId);
    return one ? [one] : uploads;
  }, [uploads, mergeAll, selectedUploadId]);

  const onRunBuild = async () => {
    if (!filesForRun.length) {
      setRunMessage({ type: "err", text: "Add at least one log CSV using Upload." });
      return;
    }
    if (enableMsisdnFilterUpload && msisdnFilterLoading) {
      setRunMessage({ type: "err", text: "MSISDN CSV is still loading. Please wait and run again." });
      return;
    }
    setRunning(true);
    setRunMessage(null);
    try {
      let totalReportedRows = 0;
      const hydratedFiles = await Promise.all(
        filesForRun.map(async (f) => ({
          name: f.name,
          text: await uploadTextById(f.id),
        }))
      );
      const validFiles = hydratedFiles.filter((f) => typeof f.text === "string" && f.text.length > 0);
      if (!validFiles.length) {
        setRunMessage({
          type: "err",
          text: "Selected uploads are empty in local storage. Please upload files again.",
        });
        return;
      }
      const endpoint = enableMsisdnFilterUpload ? "/api/run-msisdn-report" : "/api/run-report";
      const msisdnPayload =
        enableMsisdnFilterUpload && msisdnFilter
          ? { name: msisdnFilter.name, content: msisdnFilter.text }
          : null;
      const batches = splitIntoBatches(validFiles, Math.max(1, RUN_FILE_BATCH_SIZE));
      const batchMatrices = [];

      for (let i = 0; i < batches.length; i++) {
        const batch = batches[i];
        const requestBody = buildRunRequestBodyBlob(batch, msisdnPayload, { returnReportCsv: true });
        const res = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json; charset=utf-8" },
          body: requestBody,
        });
        if (res.status === 404) {
          setRunMessage({
            type: "err",
            text: "Run API unavailable. Use dev server: cd viewer-app && npm run dev",
          });
          return;
        }
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.ok) {
          setRunMessage({
            type: "err",
            text:
              `Batch ${i + 1}/${batches.length} failed: ` +
              ((data && data.error) || res.statusText || "Build failed"),
          });
          return;
        }
        const stdoutText = String(data?.stdout || "");
        const rowCountMatch = stdoutText.match(/Report rows:\s*(\d+)/i);
        if (rowCountMatch) {
          totalReportedRows += Number(rowCountMatch[1] || 0);
        }
        if (typeof data.reportCsv === "string" && data.reportCsv.trim()) {
          const matrix = parseCSV(data.reportCsv);
          if (hasCsvDataRows(matrix)) {
            batchMatrices.push(matrix);
            const previewMatrix = mergeReportMatrices(batchMatrices, { dedupe: false }) || matrix;
            applyMatrix(previewMatrix);
          }
        } else {
          setRunMessage({
            type: "err",
            text: "Run finished but batch data was empty. Please run again.",
          });
          return;
        }
      }

      const mergedMatrix = mergeReportMatrices(batchMatrices);
      let didRenderData = false;
      if (mergedMatrix && hasCsvDataRows(mergedMatrix)) {
        applyMatrix(mergedMatrix);
        didRenderData = true;
      } else {
        didRenderData = Boolean(await loadReportFromUrl());
      }
      if (!didRenderData) {
        setRunMessage({
          type: "err",
          text:
            totalReportedRows > 0
              ? "Run completed but data could not be displayed. Please run again."
              : "Run completed but no report data found. Check whether selected files contain ERROR logs.",
        });
        return;
      }
      setRunMessage({
        type: "ok",
        text: "Run Successfully",
      });
    } catch (e) {
      setRunMessage({
        type: "err",
        text: e && e.message ? e.message : "Network error (is npm run dev running?)",
      });
    } finally {
      setRunning(false);
    }
  };

  const onDownload = async () => {
    if (!downloadMatrix || !downloadMatrix.length) return;
    const workbook = XLSX.utils.book_new();
    const dataSheet = createEmptySheet();
    await appendMatrixInBatches(dataSheet, downloadMatrix, 1500);
    dataSheet["!cols"] = computeSheetCols(downloadMatrix, { maxCols: downloadMatrix?.[0]?.length || 12, maxWch: 60 });
    XLSX.utils.book_append_sheet(workbook, dataSheet, "Report Data");

    const analysisRows = buildAnalysisSheetRows(failureAnalysis, downloadMatrix.length - 1);
    appendSection(analysisRows, "Score Distribution", buildScoreDistributionSheetRows(scoreDistribution));
    appendSection(analysisRows, "Age Distribution", buildAgeDistributionSheetRows(ageDistribution));
    const analysisSheet = createEmptySheet();
    await appendMatrixInBatches(analysisSheet, analysisRows, 200);
    analysisSheet["!cols"] = computeSheetCols(analysisRows, { maxCols: 4, maxWch: 80 });
    XLSX.utils.book_append_sheet(workbook, analysisSheet, "Pivot Analysis");

    const body = new Blob(
      [XLSX.write(workbook, { type: "array", bookType: "xlsx" })],
      {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      }
    );
    const xlsxName = excelFileName(csvName);

    if (window.showSaveFilePicker) {
      try {
        const h = await window.showSaveFilePicker({
          suggestedName: xlsxName,
          types: [
            {
              description: "Excel Workbook",
              accept: {
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": [".xlsx"],
              },
            },
          ],
        });
        const w = await h.createWritable();
        await w.write(body);
        await w.close();
        return;
      } catch (e) {
        if (e && e.name === "AbortError") return;
      }
    }
    downloadBlobAsFile(body, xlsxName);
  };

  useEffect(() => {
    loadReportFromUrl();
  }, [loadReportFromUrl]);

  const hasData = Boolean(showTable && reportData);

  return (
    <div className="report-container">
      <div className="panel no-print build-panel">
        <div className="panel-row">
          <div
            className="file-pick-group"
            role="group"
            aria-label="Upload log CSV files or a folder of CSVs"
            title="Choose CSV file(s), or pick a folder to load every .csv inside it."
          >
            <label className="file-pick-segment">
              <span>Log CSV</span>
              <input
                type="file"
                accept=".csv,text/csv,text/plain"
                multiple
                onChange={onLogFilesSelected}
              />
            </label>
            <span className="file-pick-group-divider" aria-hidden="true" />
            <label className="file-pick-segment">
              <span>Folder</span>
              <input
                type="file"
                webkitdirectory=""
                directory=""
                onChange={onLogFilesSelected}
              />
            </label>
          </div>
          {uploads.length > 0 && (
            <>
              {uploads.length > 1 && (
                <label className="inline-label">
                  Source
                  <select
                    value={mergeAll ? "__all__" : selectedUploadId}
                    onChange={(e) => {
                      const v = e.target.value;
                      if (v === "__all__") setMergeAll(true);
                      else {
                        setMergeAll(false);
                        setSelectedUploadId(v);
                      }
                    }}
                  >
                    <option value="__all__">All uploaded (merge)</option>
                    {uploads.map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <button
                type="button"
                className="primary run-button"
                disabled={running}
                onClick={onRunBuild}
              >
                {running ? (
                  <>
                    <span className="loading-spinner button-spinner"></span>
                    Running...
                  </>
                ) : (
                  "Run"
                )}
              </button>
              {uploads.length > 1 && (
                <div className="upload-actions">
                  <button
                    type="button"
                    className="button delete-selected-btn"
                    disabled={uploads.length === 0}
                    onClick={async () => {
                      const ids = uploads.map((u) => u.id);
                      for (const id of ids) {
                        await deleteUpload(id, pageKey);
                      }
                      setUploads([]);
                    }}
                  >
                    Delete All
                  </button>
                </div>
              )}
            </>
          )}
        </div>
        {fileLoading && (
          <div className="file-loading-indicator">
            <span className="loading-spinner"></span>
            {fileLoading}
          </div>
        )}
        {uploads.length > 0 && (
          <ul className="upload-list">
            {uploads.map((u) => (
              <li key={u.id}>
                <span className="upload-name">{u.name}</span>
                <button type="button" className="linkish" onClick={() => removeUpload(u.id)}>
                  <MdDelete size={18} />
                </button>
              </li>
            ))}
          </ul>
        )}
        {enableMsisdnFilterUpload && msisdnFilter?.name ? (
          <p className="msisdn-filename" style={{ marginTop: ".25rem" }}>
            MSISDN list: {msisdnFilter.name}
          </p>
        ) : null}
        {runMessage && (
          <p className={runMessage.type === "err" ? "run-msg err" : "run-msg ok"}>{runMessage.text}</p>
        )}
      </div>
      <div className="toolbar no-print">
        <button
          type="button"
          className="primary"
          disabled={!hasData}
          onClick={() => window.print()}
        >
          Print / Save as PDF
        </button>
        <button
          type="button"
          className="button"
          disabled={!hasData}
          title="After data loads: Chrome/Edge can choose folder. Downloads a 2-sheet Excel workbook."
          onClick={onDownload}
        >
          Download (Excel)
        </button>
        <div className="toolbar-search">
          <MdOutlineSearch className="toolbar-search-icon" />
          <input
            type="text"
            className="toolbar-search-input"
            placeholder="Search MSISDN or SessionID..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            disabled={!hasData}
          />
        </div>
      </div>

      {hasData && tableView ? (
        <>
          {failureAnalysis && failureAnalysis.total > 0 ? (
            <section className="analysis-print-section">
              <h2>Failure Analysis Graph</h2>
              <p>
                Total analyzed rows: <strong>{failureAnalysis.total}</strong>
              </p>
              <ul className="analysis-bars">
                {failureAnalysis.items.map((item) => (
                  <li key={`print-${item.key}`}>
                    <div className="analysis-row-head">
                      <span className="analysis-label">{item.label}</span>
                      <span className="analysis-pct">
                        {item.pct}% <span className="analysis-count">({item.count})</span>
                      </span>
                    </div>
                    <div className="analysis-track" role="presentation">
                      <div
                        className="analysis-fill"
                        style={{ width: `${Math.min(100, item.pct)}%` }}
                      />
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          <div
            id="wrap"
            hidden={false}
            ref={tableWrapRef}
            onScroll={handleTableScroll}
            style={{ maxHeight: "68vh", overflow: "auto" }}
          >
            <table
              className={compactTable ? "data-table compact" : "data-table"}
              role="grid"
              aria-label="Error report"
            >
              <thead>
                <tr>
                  {tableView.displayColumns.map((col) => {
                    const lLower = col.label.toLowerCase();
                    let style = { minWidth: "100px" };
                    if (lLower.includes("attempt no")) style = { width: "48px", minWidth: "48px" };
                    else if (lLower === "shortfall") style = { width: "90px", minWidth: "80px" };
                    else if (lLower === "actual score") style = { width: "105px", minWidth: "90px" };
                    else if (lLower === "required age") style = { width: "118px", minWidth: "100px" };
                    else if (lLower === "on document") style = { width: "105px", minWidth: "90px" };
                    else if (lLower === "variance") style = { width: "95px", minWidth: "80px" };
                    else if (lLower.includes("session id") || lLower.includes("sessionid")) style = { width: "280px", minWidth: "240px" };
                    else if (lLower.includes("msisdn")) style = { width: "96px", minWidth: "90px" };
                    else if (lLower === "api") style = { width: "100px", minWidth: "90px" };
                    else if (lLower.includes("error_count") || lLower.includes("error count")) style = { width: "72px", minWidth: "68px" };
                    else if (
                      lLower.includes("failurereason") ||
                      lLower.includes("failure_reason") ||
                      lLower.includes("failure_log")
                    ) style = { width: "320px", minWidth: "280px" };
                    else if (lLower.includes("validationtype")) style = { width: "260px", minWidth: "220px" };
                    else if (lLower.includes("errorcode") || lLower.includes("error code")) style = { width: "148px", minWidth: "100px" };
                    else if (lLower.includes("details")) style = { width: "680px", minWidth: "520px" };
                    else if (lLower.includes("scorethreshold") || lLower.includes("score threshold")) style = { width: "130px", minWidth: "110px" };
                    else if (lLower.includes("date")) style = { width: "160px", minWidth: "150px" };
                    return (
                      <th key={col.key} style={style}>{col.label}</th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {virtualRows.topPad > 0 ? (
                  <tr aria-hidden="true">
                    <td colSpan={tableView.displayColumns.length} style={{ height: `${virtualRows.topPad}px`, padding: 0, border: 0 }} />
                  </tr>
                ) : null}
                {virtualRows.rows.map(({ origIndex, row }) => {
                  const seq = tableView.meta.seqByRow[origIndex] ?? "";
                  return (
                    <tr key={origIndex}>
                      {tableView.displayColumns.map((col) => {
                        const val = displayCellValue(col, row, seq);
                        const colLower = String(col.label || "").toLowerCase();
                        const isFailureLogCol =
                          colLower.includes("failurereason") ||
                          colLower.includes("failure_reason") ||
                          colLower.includes("failure_log");
                        return (
                          <td key={col.key}>
                            <div
                              className={
                                col.virtual === "session-seq"
                                  ? "cell cell-seq"
                                  : isFailureLogCol
                                  ? "cell cell-log"
                                  : "cell"
                              }
                            >
                              {val}
                            </div>
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
                {virtualRows.bottomPad > 0 ? (
                  <tr aria-hidden="true">
                    <td colSpan={tableView.displayColumns.length} style={{ height: `${virtualRows.bottomPad}px`, padding: 0, border: 0 }} />
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </>
      ) : (
        <div className="no-data">No data found</div>
      )}

      {hasData && failureAnalysis && failureAnalysis.total > 0 && (
        enableFailureAnalysis ? (
          <button
            className="analysis-fab no-print"
            onClick={() => setShowAnalysisModal(true)}
            title="Show Failure Analysis"
            aria-label="Show Failure Analysis"
          >
            <HiOutlineChartBar size={22} />
          </button>
        ) : null
      )}

      {enableFailureAnalysis ? (
        <FailureAnalysisModal
          open={showAnalysisModal && Boolean(failureAnalysis)}
          onClose={() => setShowAnalysisModal(false)}
          failureAnalysis={failureAnalysis}
          scoreDistribution={scoreDistribution}
          ageDistribution={ageDistribution}
        />
      ) : null}
    </div>
  );
}
