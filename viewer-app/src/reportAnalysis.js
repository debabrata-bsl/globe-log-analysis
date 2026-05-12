/**
 * One bucket per row (first match wins). Percentages sum to 100% of analyzed rows.
 * Uses reason, details, scoreThreshold, errorCode (case-insensitive headers).
 */

const BUCKET_ORDER = [
  "age",
  "livenessScore",
  "scorePad",
  "docUnsupported",
  "faceCovered",
  "cardCorners",
  "mrzInvalid",
  "tampering",
  "scanError",
  "passportRules",
  "foreignDoc",
  "selfie",
  "apiError",
  "asyncUpload",
  "other",
];

const BUCKET_LABELS = {
  age: "Age: Below minimum requirement",
  livenessScore: "Liveness: Score below threshold",
  scorePad: "Image Quality: Low score (Portrait/PAD/Spoof)",
  docUnsupported: "Policy: Document type not supported",
  faceCovered: "Face Visibility: Face covered or not visible",
  cardCorners: "Scan: Card corners not detected",
  mrzInvalid: "Scan: MRZ invalid or mismatch",
  tampering: "Security: Document tampering / Screen detected",
  scanError: "Scan: General OCR or processing error",
  passportRules: "Policy: Passport rules (e.g. foreigner must use passport)",
  foreignDoc: "Policy: Foreign document not allowed",
  selfie: "Identity: Selfie validation / User match failed",
  apiError: "Technical: Backend API or HTTP error",
  asyncUpload: "Technical: Document upload failed",
  other: "Other / Unclassified",
};

/** Short explanation of what log signals each bucket represents */
const BUCKET_HINTS = {
  age: "Logs: actualAge < minAge, underage, or document too young.",
  livenessScore: "Logs: liveness_score / live_face shortfall (below threshold).",
  scorePad: "Logs: SCORE_BELOW_THRESHOLD, PAD, portrait_genuine, or screenshot checks.",
  docUnsupported: "Logs: DOCUMENT_NOT_SUPPORTED — ID format not in product allow-list.",
  faceCovered: "Logs: FACE_COVERED_DETECTED or face_covered.",
  cardCorners: "Logs: NO_CARD_CORNERS_DETECTED or missing corners.",
  mrzInvalid: "Logs: MRZ_INVALID, mrz_mismatch, or data extraction failure.",
  tampering: "Logs: TAMPERING, front_page_tamper, or SCREEN_DETECTED.",
  scanError: "Logs: document_scan_error, scan_fail, or processing timeout.",
  passportRules: "Logs: ONLY_PASSPORT_ALLOWED, NON_PASSPORT_FOR_FOREIGNER.",
  foreignDoc: "Logs: FOREIGN_DOCUMENT_FOR_LOCAL_DETECTED.",
  selfie: "Logs: SELFIE_VALIDATION_FAILED, /userSelfie error.",
  apiError: "Logs: Glo API failure, 5xx status, or HTTP connection error.",
  asyncUpload: "Logs: ASYNC_DOCUMENT_UPLOAD EXCEPTION or upload timeout.",
  other: "Logs: Remaining patterns that did not match specific categories.",
};

function classifyFailureRow(blobLower) {
  const b = blobLower;

  if (/\b(actualage|minagethreshold|min age required|age on document|underage|document too young|age below|below min age|min age)\b/.test(b)) return "age";

  if (/\b(liveness|live_face|passive_live|active_live)\b/.test(b) && (/score_below_threshold|shortfall/.test(b) || (/\bactual score\b/.test(b) && /\bmin required\b/.test(b)))) return "livenessScore";

  if (/score_below_threshold/.test(b) || (/\bactual score\b/.test(b) && /\bmin required\b/.test(b))) return "scorePad";

  const patterns = [
    [/document_not_supported/, "docUnsupported"],
    [/face_covered|facenotcovered|face_covered_detected/, "faceCovered"],
    [/no_card_corners|no_card_corners_detected|missing corners/, "cardCorners"],
    [/mrz_invalid|mrz_mismatch/, "mrzInvalid"],
    [/tampering|front_page_tamper|screen_detected/, "tampering"],
    [/document_scan_error|document_scan|scan_fail|scan error/, "scanError"],
    [/non_passport|only_passport|passport.*foreign/, "passportRules"],
    [/foreign_document/, "foreignDoc"],
    [/selfie_validation|\/userselfie/, "selfie"],
    [/\bglo api\b|failed with status:\s*\d+/, "apiError"],
    [/async_document_upload/, "asyncUpload"],
  ];

  for (const [regex, key] of patterns) {
    if (regex.test(b)) return key;
  }

  return "other";
}

/**
 * @param {string[]} headers
 * @param {string[][]} dataRows
 * @returns {{ total: number, items: { key: string, label: string, hint: string, count: number, pct: number }[] }}
 */
export function analyzeReportRows(headers, dataRows) {
  if (!headers?.length || !dataRows?.length) return { total: 0, items: [] };

  const h = headers.map((x) => String(x).toLowerCase());
  const ri = h.findIndex((x) => x === "reason" || x === "failurereason" || x === "failure reason");
  const di = h.indexOf("details");
  const si = h.indexOf("scorethreshold");
  const ci = h.indexOf("errorcode");

  const cell = (row, i) => (i >= 0 && row[i] != null ? String(row[i]) : "");

  const counts = {};
  for (const k of BUCKET_ORDER) counts[k] = 0;

  for (const row of dataRows) {
    const blob = [cell(row, ri), cell(row, di), cell(row, si), cell(row, ci)].join("\n").toLowerCase();
    counts[classifyFailureRow(blob)]++;
  }

  const total = dataRows.length;
  return {
    total,
    items: BUCKET_ORDER.map((key) => ({
      key,
      label: BUCKET_LABELS[key] || key,
      hint: BUCKET_HINTS[key] || "",
      count: counts[key] || 0,
      pct: total ? Math.round((counts[key] / total) * 1000) / 10 : 0,
    }))
      .filter((x) => x.count > 0)
      .sort((a, b) => b.count - a.count),
  };
}
