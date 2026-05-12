/**
 * Analyze GCP / k8s stdout CSV exports: map eKYC BFF API calls to successes vs errors per MSISDN.
 */

/** Flow order for "first failure in journey" hints */
export const EKYC_FLOW_APIS = [
  { method: "POST", path: "/bff/api/v1/ekyc/validateAccount" },
  { method: "POST", path: "/bff/api/v1/ekyc/send-otp" },
  { method: "POST", path: "/bff/api/v1/ekyc/otp-verification" },
  { method: "GET", path: "/bff/api/v1/ekyc/check-registrations" },
  { method: "PUT", path: "/bff/api/v1/ekyc/regType" },
  { method: "POST", path: "/bff/api/v1/ekyc/documentScan" },
  { method: "POST", path: "/bff/api/v1/ekyc/userSelfie" },
  { method: "POST", path: "/bff/api/v1/ekyc/user-details/submit" },
  { method: "POST", path: "/bff/api/v1/ekyc/register" },
];

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeLogCell(s) {
  let t = String(s ?? "").trim();
  if (t.startsWith('"') && t.endsWith('"')) t = t.slice(1, -1);
  return t.replace(/^['\u2019]+/g, "").trim();
}

function headerIndex(headers, name) {
  return headers.findIndex((h) => String(h).trim().toLowerCase() === name.toLowerCase());
}

function findTextPayloadColumn(headers) {
  const h = headers.map((x) => String(x).trim().toLowerCase());
  const i = h.indexOf("textpayload");
  return i !== -1 ? i : h.findIndex((x) => x.includes("textpayload"));
}

/** Path after /ekyc, e.g. /documentScan or /user-details/submit */
function ekycRelativePath(fullPath) {
  const prefix = "/bff/api/v1/ekyc";
  return fullPath.startsWith(prefix) ? (fullPath.slice(prefix.length) || "/") : fullPath;
}

/** Logs that omit the full URL but name the service / step */
const REL_PATH_HINTS = {
  "/validateAccount": /ValidateAccount|validateAccount/i,
  "/send-otp": /SendOtp|send-otp|send_otp/i,
  "/otp-verification": /OtpVerification|otp-verification|otp_verification/i,
  "/check-registrations": /CheckRegistration|check-registrations/i,
  "/regType": /RegType|regType|reg_type/i,
  "/documentScan":
    /DocumentScanServiceImpl|DOCUMENT\s+SCAN|DOCUMENT\s+VALIDATION|\/documentScan\b/i,
  "/userSelfie": /UserSelfie|userSelfie|userselfie/i,
  "/user-details/submit": /user-details\/submit|UserDetailsSubmit|user details submit/i,
  "/register":
    /RegisterUserServiceImpl|RegisterSimServiceImpl|Starting final registration|Processing registration request|\/register\b/i,
};

/**
 * @param {string} payload
 * @param {string} fullPath e.g. /bff/api/v1/ekyc/documentScan
 */
export function payloadMentionsApi(payload, fullPath) {
  if (payload.includes(fullPath)) return true;
  const rel = ekycRelativePath(fullPath);
  if (rel === "/") return false;
  const reApi = new RegExp(`API:\\s*${escapeRe(rel)}\\b`);
  if (reApi.test(payload)) return true;
  if (new RegExp(`\\/ekyc${escapeRe(rel)}\\b`).test(payload)) return true;
  const hint = REL_PATH_HINTS[rel];
  if (hint && hint.test(payload) && /\bMSISDN:\s*\d/.test(payload)) return true;
  return false;
}

const RE_MSISDN = /MSISDN:\s*(\d{10,15})\b/g;

export function extractMsisdnsFromText(text) {
  const set = new Set();
  let m;
  const s = String(text ?? "");
  RE_MSISDN.lastIndex = 0;
  while ((m = RE_MSISDN.exec(s)) !== null) {
    set.add(m[1]);
  }
  return [...set].sort();
}

function parseBracketStatus(payload) {
  const m = payload.match(/API\s+(?:SUCCESS|ERROR|FAILURE):\s*\S+\s+(\/bff\/api\/v1\/ekyc\/[^\s]+)\s*\[(\d{3})\]/i);
  if (m) return { path: m[1], code: m[2] };
  return null;
}

/**
 * Classify one log line for a specific API path.
 * @returns {{ kind: 'success'|'error', http?: string, excerpt: string } | null}
 */
function classifyLineForApi(payload, fullPath) {
  if (!payloadMentionsApi(payload, fullPath)) return null;

  const rel = escapeRe(fullPath);
  const reSuccess = new RegExp(
    `API\\s+SUCCESS:\\s*\\S+\\s+${rel}\\s*\\[(\\d{3})\\]`,
    "i"
  );
  const reError = new RegExp(
    `API\\s+ERROR:\\s*\\S+\\s+${rel}\\s*\\[(\\d{3})\\]`,
    "i"
  );
  const reFailure = new RegExp(
    `API\\s+FAILURE:\\s*\\S+\\s+${rel}\\s*\\[(\\d{3})\\]`,
    "i"
  );

  let m = payload.match(reSuccess);
  if (m) {
    const code = m[1];
    if (/^2/.test(code)) return { kind: "success", http: code, excerpt: truncate(payload, 240) };
  }

  m = payload.match(reError) || payload.match(reFailure);
  if (m) {
    return { kind: "error", http: m[1], excerpt: truncate(payload, 240) };
  }

  const bracket = parseBracketStatus(payload);
  if (bracket && bracket.path === fullPath && !/^2/.test(bracket.code)) {
    return { kind: "error", http: bracket.code, excerpt: truncate(payload, 240) };
  }

  if (
    /\bStatus:\s*FAILED\b/i.test(payload) &&
    (payload.includes(fullPath) || payloadMentionsApi(payload, fullPath))
  ) {
    const httpFromLine = payload.match(/\[(\d{3})\]/)?.[1];
    return {
      kind: "error",
      http: httpFromLine || "",
      excerpt: truncate(payload, 280),
    };
  }

  const hasErrorLevel =
    /\|\s*ERROR\s+/.test(payload) || /\]\s+ERROR\s+/.test(payload);
  if (
    hasErrorLevel &&
    /FAILED|EXCEPTION|💥|❌/i.test(payload) &&
    (payload.includes(fullPath) || payloadMentionsApi(payload, fullPath))
  ) {
    const httpFromLine = payload.match(/API\s+ERROR:.*?\[(\d{3})\]/)?.[1];
    return {
      kind: "error",
      http: httpFromLine || "",
      excerpt: truncate(payload, 280),
    };
  }

  return null;
}

function truncate(s, n) {
  const t = String(s).replace(/\s+/g, " ").trim();
  if (t.length <= n) return t;
  return t.slice(0, n - 1) + "…";
}

function parseTs(raw) {
  const s = normalizeLogCell(raw);
  const iso = s.replace(/^'+/, "").trim();
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
}

/**
 * @param {string[][]} matrix - parsed CSV with header row 0
 * @returns {object}
 */
export function analyzeMsisdnExportCsv(matrix) {
  if (!matrix?.length || matrix.length < 2) {
    return { ok: false, error: "CSV has no data rows.", msisdns: [], rowCount: 0, events: [], byApi: [], firstFailureInFlow: null, firstErrorChronological: null };
  }

  const headers = matrix[0].map((h) => String(h));
  const textIdx = findTextPayloadColumn(headers);
  if (textIdx === -1) {
    return { ok: false, error: 'No "textPayload" column found. Export GCP logs with the message body column.', msisdns: [], rowCount: 0, events: [], byApi: [], firstFailureInFlow: null, firstErrorChronological: null };
  }

  const tsIdx = headerIndex(headers, "timestamp");
  const sevIdx = headerIndex(headers, "severity");
  const insertIdx = headerIndex(headers, "insertid");

  const allMsisdn = new Set();
  const events = [];

  for (let r = 1; r < matrix.length; r++) {
    const row = matrix[r];
    if (!row) continue;
    const payload = normalizeLogCell(row[textIdx]);
    if (!payload) continue;

    const msisdns = extractMsisdnsFromText(payload);
    msisdns.forEach((m) => allMsisdn.add(m));
    const msisdn = msisdns[0] || "";
    const ts = tsIdx >= 0 ? parseTs(row[tsIdx]) : 0;
    const insertId = insertIdx >= 0 ? normalizeLogCell(row[insertIdx]) : String(r);

    for (const { method, path } of EKYC_FLOW_APIS) {
      const hit = classifyLineForApi(payload, path);
      if (!hit) continue;
      events.push({
        apiPath: path,
        method,
        kind: hit.kind,
        http: hit.http || "",
        msisdn,
        ts,
        row: r + 1,
        excerpt: hit.excerpt,
        insertId,
        severity: sevIdx >= 0 ? normalizeLogCell(row[sevIdx]) : "",
      });
    }
  }

  events.sort((a, b) => a.ts - b.ts || a.row - b.row);

  const byPath = new Map();
  for (const e of events) {
    if (!byPath.has(e.apiPath)) byPath.set(e.apiPath, []);
    byPath.get(e.apiPath).push(e);
  }

  const byApi = EKYC_FLOW_APIS.map(({ method, path }) => {
    const list = byPath.get(path) || [];
    const errors = list.filter((x) => x.kind === "error");
    const oks = list.filter((x) => x.kind === "success");
    const last = list[list.length - 1];
    const lastErr = errors.length ? errors[errors.length - 1] : null;
    let status = "no_traffic";
    if (errors.length) status = "error";
    else if (oks.length) status = "ok";

    const excerptForErrors = lastErr ? lastErr.excerpt : "";
    const excerptLastEvent = last ? last.excerpt : "";
    const httpForSummary = lastErr?.http || last?.http || "";

    return {
      method,
      path,
      status,
      errorCount: errors.length,
      successCount: oks.length,
      lastHttp: httpForSummary,
      lastKind: last?.kind || "",
      lastExcerpt: errors.length ? excerptForErrors : excerptLastEvent,
      lastOutcomeHttp: last?.http || "",
      recovered: errors.length > 0 && last?.kind === "success",
      samples: errors.slice(0, 5),
    };
  });

  let firstFailureInFlow = null;
  for (const { path } of EKYC_FLOW_APIS) {
    const list = byPath.get(path) || [];
    const firstErr = list.find((x) => x.kind === "error");
    if (firstErr) {
      firstFailureInFlow = firstErr;
      break;
    }
  }

  const errorEvents = events.filter((e) => e.kind === "error");
  let firstErrorChronological = null;
  if (errorEvents.length) {
    firstErrorChronological = errorEvents.reduce((a, b) => {
      if (!a) return b;
      if (b.ts < a.ts) return b;
      if (b.ts === a.ts && b.row < a.row) return b;
      return a;
    }, null);
  }

  return {
    ok: true,
    error: "",
    msisdns: [...allMsisdn].sort(),
    rowCount: matrix.length - 1,
    events,
    byApi,
    firstFailureInFlow,
    firstErrorChronological,
  };
}
