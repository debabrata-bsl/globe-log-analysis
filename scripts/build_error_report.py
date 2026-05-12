"""Build my_error_report.csv from application error/exception log lines."""
import json
import os
import re
from pathlib import Path

import pandas as pd

DEFAULT_PHOTO_ERROR_TO_CODE = {
    "Selfie validation failed": "SELFIE_VALIDATION_FAILED",
}
DEFAULT_ASYNC_DOCUMENT_UPLOAD_EXCEPTION = "ASYNC_DOCUMENT_UPLOAD EXCEPTION"
DEFAULT_ASYNC_DOCUMENT_UPLOAD_PROCESS_EXCEPTION = "ASYNC_DOCUMENT_UPLOAD_PROCESS EXCEPTION"
DEFAULT_PREFERRED_LOG = "downloaded-logs.csv"
DEFAULT_INPUT_GLOB = "downloaded-logs*.csv"
DEFAULT_UPLOAD_INPUT_GLOB = "input_*.csv"
DEFAULT_VIEWER_PUBLIC_DIR = str(Path("viewer-app") / "public")
DEFAULT_REPORT_OUTPUT_NAME = "my_error_report.csv"
DEFAULT_INPUT_COLUMNS = (
    "textPayload",
    "severity",
    "timestamp",
    "time",
    "time_stamp",
    "receiveTimestamp",
    "receive_timestamp",
    "insertId",
    "insert_id",
)
DEFAULT_DEDUPE_FIELDS = ("sessionid", "errorCode", "reason", "scoreThreshold")

RE_MSISDN = re.compile(r"MSISDN:\s*(\d+)")
RE_SESSION_PATTERNS = [
    re.compile(r"\bSession\s*:\s*([A-Za-z0-9-]+)", re.IGNORECASE),
    re.compile(r"\bsessionId\s*[:=]\s*([A-Za-z0-9-]+)", re.IGNORECASE),
    re.compile(r"\bsession[_ -]?id\s*[:=]\s*([A-Za-z0-9-]+)", re.IGNORECASE),
    re.compile(r"\bSessionId\s*[:=]\s*([A-Za-z0-9-]+)", re.IGNORECASE),
]
RE_ERROR_MESSAGE = re.compile(r"Error:\s*(.+?)(?:\s*\|?)$")
RE_API_ENDPOINT = re.compile(r"API:\s*(\S+)")
RE_ERROR_CODE = re.compile(r"errorCode=([A-Z0-9_]+)")
RE_ERROR_DETAILS = re.compile(r"errorDetails=(.*?)(?:,\s*failureMetadata=|\)$)")
RE_EXCEPTION_LABEL = re.compile(r"💥\s*([^:]+):")
RE_FAILURE_METADATA = re.compile(r"failureMetadata=\{([^}]*)\}")
RE_ACTUAL_SCORE = re.compile(r"\bactual\s*score\s*([+-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)", re.I)
RE_SHORTFALL = re.compile(r"\bshortfall\s*([+-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)", re.I)
RE_SCORE_PAIR_STRICT = re.compile(
    r"actual\s+score\s+([\d.+\-eE]+)\s*;\s*min\s+required\s+([\d.+\-eE]+)",
    re.I,
)
RE_SCORE_PAIR_FALLBACK = re.compile(
    r"actual\s+score\s+([\d.+\-eE]+).*?min\s+required\s+([\d.+\-eE]+)",
    re.I | re.S,
)
RE_AGE_PAIR_STRICT = re.compile(
    r"age\s+on\s+document\s+(\d+)\s*;\s*min\s+age\s+required\s+(\d+)",
    re.I,
)
RE_AGE_PAIR_FALLBACK = re.compile(
    r"age\s+on\s+document\s+(\d+).*?min\s+age\s+required\s+(\d+)",
    re.I | re.S,
)
RE_AGE_SINGLE = re.compile(r"age\s+on\s+document\s+(\d+)", re.I)
RE_SCORE_SEGMENT_SLASH = re.compile(r"^[\d.+\-eE]+\s*/\s*[\d.+\-eE]+")
RE_SCORE_SEGMENT_MIN = re.compile(r"^[\d.+\-eE]+\s*\(\s*min\s+[\d.+\-eE]+\s*\)", re.I)
KEY_VALUE_PATTERNS = {
    key: re.compile(rf"{re.escape(key)}=([^,}})]+)")
    for key in ("failureReason", "failureType", "supportLevel", "validationType")
}
RE_STRIP_SESSION_BAR = re.compile(r"\s*\|\s*Session:\s*[A-Za-z0-9-]+\s*", re.IGNORECASE)
RE_STRIP_SESSION_LEAD = re.compile(r"\bSession:\s*[A-Za-z0-9-]+\s*\|\s*", re.IGNORECASE)
RE_STRIP_MSISDN_BAR = re.compile(r"\s*\|\s*MSISDN:\s*\d+\s*", re.IGNORECASE)
RE_STRIP_MSISDN_LEAD = re.compile(r"\bMSISDN:\s*\d+\s*\|\s*", re.IGNORECASE)
RE_STRIP_TRAIL_BAR = re.compile(r"\s*\|\s*$")
RE_STRIP_LEAD_BAR = re.compile(r"^\s*\|\s*")
RE_STRIP_MULTI_BAR = re.compile(r"\|\s*\|+")
RE_JAVA_LOG_PREFIX = re.compile(
    r"^\d{4}-\d{2}-\d{2}\s+[\d.:]+\s+\[[^\]]+\]\s+ERROR\s+\S+\s+-\s*"
)
COLUMN_ALIASES = {
    "insert_id": "insertId",
    "log_name": "logName",
    "receive_location": "receiveLocation",
    "receive_timestamp": "receiveTimestamp",
    "cluster_name": "resource.labels.cluster_name",
    "container_name": "resource.labels.container_name",
    "location": "resource.labels.location",
    "namespace_name": "resource.labels.namespace_name",
    "pod_name": "resource.labels.pod_name",
    "project_id": "resource.labels.project_id",
    "type": "resource.type",
}

def _env_str(name: str, default: str) -> str:
    value = os.environ.get(name, "").strip()
    return value or default


def _env_csv(name: str, default: tuple[str, ...]) -> tuple[str, ...]:
    value = os.environ.get(name, "").strip()
    if not value:
        return default
    parsed = tuple(x.strip() for x in value.split(",") if x.strip())
    return parsed or default


def _env_json_map(name: str, default: dict[str, str]) -> dict[str, str]:
    value = os.environ.get(name, "").strip()
    if not value:
        return default
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError:
        return default
    if not isinstance(parsed, dict):
        return default
    out: dict[str, str] = {}
    for k, v in parsed.items():
        out[str(k)] = str(v)
    return out or default


PHOTO_ERROR_TO_CODE = _env_json_map("REPORT_PHOTO_ERROR_TO_CODE_JSON", DEFAULT_PHOTO_ERROR_TO_CODE)
ASYNC_DOCUMENT_UPLOAD_EXCEPTION = _env_str(
    "REPORT_ASYNC_DOCUMENT_UPLOAD_EXCEPTION_LABEL",
    DEFAULT_ASYNC_DOCUMENT_UPLOAD_EXCEPTION,
)
ASYNC_DOCUMENT_UPLOAD_PROCESS_EXCEPTION = _env_str(
    "REPORT_ASYNC_DOCUMENT_UPLOAD_PROCESS_EXCEPTION_LABEL",
    DEFAULT_ASYNC_DOCUMENT_UPLOAD_PROCESS_EXCEPTION,
)
PREFERRED_LOG = _env_str("REPORT_PREFERRED_LOG", DEFAULT_PREFERRED_LOG)
INPUT_GLOB = _env_str("REPORT_INPUT_GLOB", DEFAULT_INPUT_GLOB)
UPLOAD_INPUT_GLOB = _env_str("REPORT_UPLOAD_INPUT_GLOB", DEFAULT_UPLOAD_INPUT_GLOB)
VIEWER_APP_PUBLIC = Path(_env_str("REPORT_OUTPUT_DIR", DEFAULT_VIEWER_PUBLIC_DIR))
OUTPUT_PATH = VIEWER_APP_PUBLIC / _env_str("REPORT_DEFAULT_OUTPUT_NAME", DEFAULT_REPORT_OUTPUT_NAME)
INPUT_COLUMNS = set(_env_csv("REPORT_INPUT_COLUMNS", DEFAULT_INPUT_COLUMNS))
REPORT_DEDUPE_FIELDS = list(_env_csv("REPORT_DEDUPE_FIELDS", DEFAULT_DEDUPE_FIELDS))

def output_path() -> Path:
    name = os.environ.get("REPORT_OUTPUT_NAME", "").strip()
    if not name:
        return OUTPUT_PATH
    # safety: file name only
    safe = re.sub(r"[^\w.\-]", "_", name) or "my_error_report.csv"
    return VIEWER_APP_PUBLIC / safe

def normalize_text_payload(s: str) -> str:
    s = s if isinstance(s, str) else str(s) if s is not None and pd.notna(s) else ""
    s = s.strip()
    s = s.strip('"').strip("'")
    return s


def normalize_input_frame(df: pd.DataFrame) -> pd.DataFrame:
    out = df.rename(columns=lambda c: COLUMN_ALIASES.get(c, c)).copy()
    for col in ("textPayload", "severity", "timestamp", "time", "time_stamp", "receiveTimestamp"):
        if col in out.columns:
            out[col] = out[col].map(normalize_text_payload)
    return out


def extract_msisdn(text: str) -> str | None:
    m = RE_MSISDN.search(text)
    return m.group(1) if m else None


def extract_session_id(text: str) -> str | None:
    for pattern in RE_SESSION_PATTERNS:
        m = pattern.search(text)
        if m:
            value = m.group(1).strip()
            if value:
                return value
    return None


def extract_error_message(text: str) -> str | None:
    """Extract error message from 'Error: ...' pattern in textPayload."""
    # Match "Error: ..." until end of string or pipe character
    m = RE_ERROR_MESSAGE.search(text)
    if m:
        return m.group(1).strip()
    return None


def extract_api_endpoint(text: str) -> str | None:
    """Extract API endpoint from 'API: ...' pattern in textPayload."""
    m = RE_API_ENDPOINT.search(text)
    if m:
        return m.group(1).strip()
    return None


def extract_error_code(text: str) -> str | None:
    m = RE_ERROR_CODE.search(text)
    return m.group(1) if m else None


def extract_error_details(text: str) -> str | None:
    # Typical format: errorDetails=..., failureMetadata=...
    # errorDetails text can include commas, so stop at ", failureMetadata=" when present.
    m = RE_ERROR_DETAILS.search(text)
    if not m:
        return None
    s = m.group(1).strip()
    return s if s else None


def extract_exception_label(text: str) -> str | None:
    # Example: "💥 DOCUMENT SCAN API EXCEPTION:" -> "DOCUMENT SCAN API EXCEPTION"
    m = RE_EXCEPTION_LABEL.search(text)
    if not m:
        return None
    s = m.group(1).strip()
    return s if s else None


def _extract_key_values(text: str, key: str) -> list[str]:
    # Capture values until comma/brace/closing parenthesis while allowing lowercase and hyphen.
    pat = KEY_VALUE_PATTERNS.get(key)
    if not pat:
        pat = re.compile(rf"{re.escape(key)}=([^,}})]+)")
    found = pat.findall(text)
    seen: set[str] = set()
    out: list[str] = []
    for v in found:
        token = v.strip()
        if token and token not in seen:
            seen.add(token)
            out.append(token)
    return out


def extract_failure_reasons(text: str) -> tuple[list[str], list[str]]:
    """
    Return two lists:
    - primary_reasons: failureReason values (used for business detail mapping)
    - reason_signals: all important reason-like tokens for the report Reason column
      (failureReason, failureType, supportLevel, validationType)
    """
    reason_signals: list[str] = []
    seen: set[str] = set()
    for key in ("failureReason", "failureType", "supportLevel", "validationType"):
        for value in _extract_key_values(text, key):
            tagged = f"{key}={value}"
            if tagged not in seen:
                seen.add(tagged)
                reason_signals.append(tagged)
    primary_reasons = _extract_key_values(text, "failureReason")
    return primary_reasons, reason_signals


def extract_failure_metadata_map(text: str) -> dict[str, str]:
    """Parse failureMetadata={k=v, k2=v2, ...} from a log line (flat, comma-separated)."""
    m = RE_FAILURE_METADATA.search(text)
    if not m:
        return {}
    inner = m.group(1).strip()
    if not inner:
        return {}
    out: dict[str, str] = {}
    for part in inner.split(", "):
        if "=" not in part:
            continue
        k, _, v = part.partition("=")
        out[k.strip()] = v.strip()
    return out


def format_values_from_metadata(meta: dict[str, str]) -> str:
    """Human line with score or age values from the log (evidence for the report)."""
    if not meta:
        return ""
    if "actualScore" in meta or "threshold" in meta:
        parts: list[str] = []
        if "actualScore" in meta:
            parts.append(f"actual score {meta['actualScore']}")
        if "threshold" in meta:
            parts.append(f"min required {meta['threshold']}")
        if "scoreDifference" in meta:
            parts.append(f"shortfall {meta['scoreDifference']}")
        if "validationType" in meta:
            parts.append(f"check: {meta['validationType']}")
        return "Log values: " + "; ".join(parts)
    if "actualAge" in meta or "minAgeThreshold" in meta:
        parts = []
        if "actualAge" in meta:
            parts.append(f"age on document {meta['actualAge']}")
        if "minAgeThreshold" in meta:
            parts.append(f"min age required {meta['minAgeThreshold']}")
        if "ageDifference" in meta:
            parts.append(f"below by {meta['ageDifference']}")
        if "maxAgeThreshold" in meta:
            parts.append(f"max age cap {meta['maxAgeThreshold']}")
        return "Log values: " + "; ".join(parts)
    return "Log values: " + ", ".join(f"{k}={v}" for k, v in sorted(meta.items()))


def _is_liveness_metadata(meta: dict[str, str]) -> bool:
    """True when failureMetadata describes a liveness check (not generic document PAD)."""
    vt = (meta.get("validationType") or "").lower()
    fr = (meta.get("failureReason") or "").upper()
    sl = (meta.get("supportLevel") or "").lower()
    return (
        "liveness" in vt
        or "liveness" in fr
        or "liveness" in sl
        or "LIVENESS" in fr
        or "LIVE_FACE" in fr
        or "ACTIVE_LIVE" in fr
        or "PASSIVE_LIVE" in fr
    )


def extract_score_threshold(meta: dict[str, str]) -> str:
    """
    Compact metrics for scoreThreshold column.
    Liveness: emphasize incoming actual score, e.g. 0.452 (min 0.70).
    Non-liveness score: actualScore / threshold; age: document age only (e.g. 13).
    """
    if not meta:
        return ""
    parts: list[str] = []
    if "actualScore" in meta and "threshold" in meta:
        if _is_liveness_metadata(meta):
            parts.append(f"{meta['actualScore']} (min {meta['threshold']})")
        else:
            parts.append(f"{meta['actualScore']} / {meta['threshold']}")
    elif "actualScore" in meta and _is_liveness_metadata(meta):
        parts.append(str(meta["actualScore"]).strip())
    if "actualAge" in meta:
        parts.append(str(meta["actualAge"]).strip())
    return " | ".join(parts) if parts else ""


def parse_score_age_from_log_blob(blob: str) -> tuple[str, str]:
    """
    Parse score/threshold and age/min age from human 'Log values:' text when
    failureMetadata keys are missing from the line.
    Returns (score_part, age_part) like ('0.59 / 0.7', '14') — age is document age only.
    """
    if not blob:
        return "", ""
    score_part = ""
    age_part = ""
    sm = RE_SCORE_PAIR_STRICT.search(blob)
    if not sm:
        sm = RE_SCORE_PAIR_FALLBACK.search(blob)
    if sm:
        a, th = sm.group(1), sm.group(2)
        blob_l = blob.lower()
        if "liveness" in blob_l or "live_face" in blob_l or "active_live" in blob_l:
            score_part = f"{a} (min {th})"
        else:
            score_part = f"{a} / {th}"
    am = RE_AGE_PAIR_STRICT.search(blob)
    if not am:
        am = RE_AGE_PAIR_FALLBACK.search(blob)
    if am:
        age_part = am.group(1)
    else:
        one = RE_AGE_SINGLE.search(blob)
        if one:
            age_part = one.group(1)
    return score_part, age_part


def _meta_or_string_has_score(meta: dict[str, str], from_meta: str) -> bool:
    if meta.get("actualScore") and meta.get("threshold"):
        return True
    s = (from_meta or "").strip()
    if not s:
        return False

    def _looks_like_score_segment(seg: str) -> bool:
        seg = seg.strip()
        if RE_SCORE_SEGMENT_SLASH.match(seg):
            return True
        if RE_SCORE_SEGMENT_MIN.match(seg):
            return True
        return False

    if _looks_like_score_segment(s):
        return True
    if " | " in s:
        first = s.split(" | ", 1)[0].strip()
        return _looks_like_score_segment(first)
    return False


def _meta_or_string_has_age(meta: dict[str, str], from_meta: str) -> bool:
    if meta.get("actualAge"):
        return True
    s = (from_meta or "").strip()
    if "age" in s.lower():
        return True
    # Combined "0.59 / 0.7 | 13" — trailing segment is document age
    if " | " in s:
        tail = s.rsplit(" | ", 1)[-1].strip()
        if tail.isdigit():
            return True
    if s.isdigit():
        return True
    return False


def merge_score_threshold(meta: dict[str, str], details: str, row_text: str) -> str:
    """Prefer failureMetadata; fill score/age from log text if still missing."""
    from_meta = extract_score_threshold(meta)
    blob = f"{details} {row_text}"
    score_txt, age_txt = parse_score_age_from_log_blob(blob)

    if from_meta:
        out = from_meta
        if score_txt and not _meta_or_string_has_score(meta, from_meta):
            out = f"{out} | {score_txt}"
        if age_txt and not _meta_or_string_has_age(meta, from_meta):
            out = f"{out} | {age_txt}"
        return out

    parts = [p for p in (score_txt, age_txt) if p]
    return " | ".join(parts) if parts else ""


def strip_redundant_identifiers(text: str) -> str:
    """Remove Session / MSISDN fragments from a log line (shown in other columns or unwanted)."""
    if not text:
        return text
    t = text
    t = RE_STRIP_SESSION_BAR.sub(" | ", t)
    t = RE_STRIP_SESSION_LEAD.sub("", t)
    t = RE_STRIP_MSISDN_BAR.sub(" | ", t)
    t = RE_STRIP_MSISDN_LEAD.sub("", t)
    t = RE_STRIP_TRAIL_BAR.sub("", t)
    t = RE_STRIP_LEAD_BAR.sub("", t)
    t = RE_STRIP_MULTI_BAR.sub("|", t)
    t = re.sub(r"\s+", " ", t).strip()
    return t


def strip_java_log_prefix(text: str) -> str:
    """Drop leading timestamp / thread / logger prefix on noisy ERROR lines."""
    if not text:
        return text
    return RE_JAVA_LOG_PREFIX.sub("", text).strip()


def strip_base64_image_tail(text: str) -> str:
    """Replace embedded base64 image blobs in log lines with a short placeholder."""
    if not text or "Base64 image data" not in text:
        return text
    low = text.lower()
    marker = "failed upload:"
    i = low.find(marker)
    if i == -1:
        return text[:500] + ("…" if len(text) > 500 else "")
    cut = i + len(marker)
    return text[:cut].rstrip() + " [image data omitted]"


def sanitize_details_display(details: str) -> str:
    """Remove session/MSISDN noise and common log boilerplate from the details cell."""
    if not details:
        return details
    d = strip_java_log_prefix(details)
    d = strip_redundant_identifiers(d)
    d = strip_base64_image_tail(d)
    return d


def is_user_selfie_context(api_endpoint: str | None, row_text: str) -> bool:
    if api_endpoint and "userSelfie" in api_endpoint:
        return True
    t = row_text or ""
    return "/userSelfie" in t or "userSelfie" in t


def refine_details_column(
    row_text: str,
    provisional_details: str,
    api_endpoint: str | None,
) -> str:
    """
    Selfie (/userSelfie): full raw log line as details (exact error log).
    sanitize_details_display is not applied to these rows so Session/MSISDN/timestamp stay visible.
    Other rows: prefer technical tail after ' | Log values:' when present (drop static user copy).
    """
    if is_user_selfie_context(api_endpoint, row_text):
        return row_text

    if provisional_details and " | Log values:" in provisional_details:
        tail = provisional_details.split(" | Log values:", 1)[1].strip()
        return f"Log values: {tail}" if tail else provisional_details

    return provisional_details if provisional_details else row_text


def build_details(
    text: str,
) -> str:
    lines: list[str] = []
    err_details = extract_error_details(text)
    if err_details:
        lines.append(err_details)

    meta = extract_failure_metadata_map(text)
    v = format_values_from_metadata(meta)
    static = " | ".join(lines) if lines else ""
    if static and v:
        return f"{static} | {v}"
    if v:
        return v
    return static


def is_base64_upload_noise_row(details: str, row_text: str) -> bool:
    """
    Drop standalone '📄 ASYNC_DOCUMENT_UPLOAD: Base64 image data...' lines.
    The actionable row is the matching 💥 ASYNC_DOCUMENT_UPLOAD EXCEPTION line.
    """
    d = details or ""
    raw = row_text or ""
    if "📄 ASYNC_DOCUMENT_UPLOAD" not in d and "📄 ASYNC_DOCUMENT_UPLOAD" not in raw:
        return False
    if "Base64 image data" not in d and "Base64 image data" not in raw:
        return False
    if "💥" in d or "EXCEPTION" in d or "failed with status" in d.lower():
        return False
    if "💥" in raw or ("EXCEPTION" in raw and "ASYNC_DOCUMENT_UPLOAD" in raw):
        return False
    return True


def norm_report_cell(val) -> str:
    """Stable string for dedupe (handles NaN, odd whitespace)."""
    if val is None or (isinstance(val, float) and pd.isna(val)):
        return ""
    s = str(val).strip()
    return re.sub(r"\s+", " ", s)


def canonicalize_reason_tags(reason: str) -> str:
    """Same failureReason tags in different order -> one key for dedupe."""
    s = norm_report_cell(reason)
    if not s or "," not in s:
        return s
    parts = [p.strip() for p in s.split(",") if p.strip()]
    if len(parts) <= 1:
        return s
    parts.sort(key=str.lower)
    return ", ".join(parts)


def drop_semantic_duplicates(report: pd.DataFrame) -> pd.DataFrame:
    """Collapse rows that look the same after normalizing whitespace and tag order."""
    if report.empty:
        return report
    out = report.copy()
    for col in ("msisdn", "sessionid", "errorCode", "reason", "details", "scoreThreshold"):
        if col in out.columns:
            out[col] = out[col].fillna("").astype(str)
    reason_norm = out["reason"].map(canonicalize_reason_tags) if "reason" in out.columns else ""
    out["_sem_fp"] = (
        out.get("msisdn", "").astype(str)
        + "|"
        + out.get("sessionid", "").astype(str)
        + "|"
        + out.get("errorCode", "").astype(str)
        + "|"
        + reason_norm
        + "|"
        + out.get("details", "").astype(str)
        + "|"
        + out.get("scoreThreshold", "").astype(str)
    )
    out = out.drop_duplicates(subset=["_sem_fp"], keep="first").reset_index(drop=True)
    return out.drop(columns=["_sem_fp"], errors="ignore")


def drop_async_process_duplicates(report: pd.DataFrame) -> pd.DataFrame:
    """
    Keep ASYNC_DOCUMENT_UPLOAD EXCEPTION and drop PROCESS variant when both
    exist for the same msisdn + sessionid pair.
    """
    if report.empty:
        return report

    def _norm_reason(reason: str) -> str:
        r = str(reason or "").upper()
        # Handle known typo variants from logs/requests.
        r = r.replace("DOCUMNET", "DOCUMENT")
        r = r.replace("EXCAPTION", "EXCEPTION")
        r = r.replace("EXCPTION", "EXCEPTION")
        return re.sub(r"\s+", " ", r).strip()

    normalized = report["reason"].map(_norm_reason)
    base_rows = normalized == ASYNC_DOCUMENT_UPLOAD_EXCEPTION
    if not base_rows.any():
        return report

    keep_pairs = pd.MultiIndex.from_frame(report.loc[base_rows, ["msisdn", "sessionid"]].astype(str))
    process_rows = normalized == ASYNC_DOCUMENT_UPLOAD_PROCESS_EXCEPTION
    row_pairs = pd.MultiIndex.from_frame(report.loc[:, ["msisdn", "sessionid"]].astype(str))
    process_dupe = process_rows & row_pairs.isin(keep_pairs)
    if process_dupe.any():
        return report.loc[~process_dupe].reset_index(drop=True)
    return report


def input_log_paths() -> list[Path]:
    """
    Order of precedence:
    1) LOG_CSV_DIR — directory containing input_0.csv, input_1.csv, ... (frontend / API uploads).
    2) Preferred single file + glob in project folder (CLI).
    """
    here = Path(".")
    upload_dir = os.environ.get("LOG_CSV_DIR", "").strip()
    if upload_dir:
        d = Path(upload_dir).resolve()
        if not d.is_dir():
            raise SystemExit(f"LOG_CSV_DIR is not a directory: {d}")
        paths = sorted(d.glob(UPLOAD_INPUT_GLOB), key=lambda x: x.name)
        if paths:
            return paths
        raise SystemExit(f"No {UPLOAD_INPUT_GLOB} files under LOG_CSV_DIR={d}")

    p = here / PREFERRED_LOG
    if p.is_file():
        return [p]
    matches = sorted(here.glob(INPUT_GLOB), key=lambda x: x.name)
    if matches:
        return matches
    raise SystemExit(
        f"No log CSV found. Add {PREFERRED_LOG} or one or more {INPUT_GLOB} in this folder."
    )


def main() -> None:
    log_paths = input_log_paths()
    if len(log_paths) == 1:
        print(f"Using log file: {log_paths[0].name}")
    else:
        print(f"Merging {len(log_paths)} log files (alphabetical by name):")
        for lp in log_paths:
            print(f"  {lp.name}")

    frames: list[pd.DataFrame] = []
    for lp in log_paths:
        d = pd.read_csv(
            lp,
            usecols=lambda c: c in INPUT_COLUMNS,
            dtype=str,
            low_memory=False,
            on_bad_lines="warn",
        )
        frames.append(normalize_input_frame(d))
    df = pd.concat(frames, ignore_index=True)
    if "textPayload" not in df.columns:
        raise SystemExit("Missing textPayload column (required in every log CSV).")

    # Same log line can appear in overlapping exports; drop before building rows.
    n_before = len(df)
    df["_text_norm"] = df["textPayload"].map(normalize_text_payload)
    df = df.drop_duplicates(subset=["_text_norm"], keep="first").reset_index(drop=True)
    if n_before != len(df):
        print(f"Dropped {n_before - len(df)} duplicate textPayload lines across merged files.")

    text = df["_text_norm"]
    # Include ALL errors across the app.
    # - Primary: severity column equals ERROR (broad, covers any API failures logged as ERROR)
    # - Fallback: any "💥 ... EXCEPTION" marker (sometimes present even when severity isn't ERROR)
    # - Additional: textPayload contains " ERROR " keyword (catches cases where severity is INFO but text has ERROR)
    sev = (
        df["severity"].astype(str).map(normalize_text_payload).str.upper()
        if "severity" in df.columns
        else pd.Series("", index=df.index)
    )
    mask = (sev == "ERROR") | (
        text.str.contains("💥", na=False, regex=False)
        & text.str.contains("EXCEPTION", na=False, regex=False)
    ) | (
        text.str.contains(" ERROR ", na=False, regex=False)
    )
    df_err = df.loc[mask]
    text_err = text.loc[mask]

    # Find the time column in the original dataframe
    time_col = next((c for c in df.columns if c.lower() in ("timestamp", "time", "time_stamp")), None)

    report_rows: list[dict] = []
    text_values = text_err.to_numpy()
    if time_col and time_col in df_err.columns:
        time_values = df_err[time_col].to_numpy()
    else:
        time_values = None

    # Local bindings reduce global lookups in the hot loop.
    extract_msisdn_fn = extract_msisdn
    extract_session_id_fn = extract_session_id
    extract_error_code_fn = extract_error_code
    extract_error_message_fn = extract_error_message
    extract_api_endpoint_fn = extract_api_endpoint
    extract_failure_reasons_fn = extract_failure_reasons
    extract_exception_label_fn = extract_exception_label
    build_details_fn = build_details
    extract_failure_metadata_map_fn = extract_failure_metadata_map
    refine_details_column_fn = refine_details_column
    merge_score_threshold_fn = merge_score_threshold
    is_user_selfie_context_fn = is_user_selfie_context
    sanitize_details_display_fn = sanitize_details_display
    is_base64_upload_noise_row_fn = is_base64_upload_noise_row
    normalize_text_payload_fn = normalize_text_payload
    actual_score_re = RE_ACTUAL_SCORE
    shortfall_re = RE_SHORTFALL
    report_rows_append = report_rows.append

    for i, row_text in enumerate(text_values):
        log_time = ""
        if time_values is not None and pd.notna(time_values[i]):
            log_time = normalize_text_payload_fn(time_values[i])
        
        msisdn = extract_msisdn_fn(row_text)
        session_id = extract_session_id_fn(row_text)
        code = extract_error_code_fn(row_text)
        error_msg = extract_error_message_fn(row_text)
        api_endpoint = extract_api_endpoint_fn(row_text)
        _, reason_signals = extract_failure_reasons_fn(row_text)

        # errorCode column: use extracted code, or map photo error message to code
        if code:
            code_str = code
        else:
            # Check if it's a photo error with known message
            code_str = PHOTO_ERROR_TO_CODE.get(error_msg, "")

        # reason column
        reason_str = ", ".join(reason_signals) if reason_signals else ""
        if not reason_str and code:
            # Fallback: no failureReason in metadata; surface errorCode
            reason_str = code
        if not reason_str and error_msg:
            # Use extracted error message
            reason_str = error_msg
        if not reason_str:
            lbl = extract_exception_label_fn(row_text)
            if lbl:
                reason_str = lbl

        details = build_details_fn(row_text)

        # details column: prefer details derived directly from logs
        if not details:
            if error_msg and api_endpoint:
                details = f"{error_msg} | API: {api_endpoint}"
            elif error_msg:
                details = error_msg
            elif api_endpoint:
                details = f"API: {api_endpoint}"

        meta = extract_failure_metadata_map_fn(row_text)
        details = refine_details_column_fn(row_text, details, api_endpoint)
        score_threshold = merge_score_threshold_fn(meta, details, row_text)
        # Keep full raw log line for /userSelfie (sanitize strips timestamp, Session, MSISDN).
        if not is_user_selfie_context_fn(api_endpoint, row_text):
            details = sanitize_details_display_fn(details)

        if is_base64_upload_noise_row_fn(details, row_text):
            continue

        details = details.replace("💥", "").strip() if details else details
        reason_str = reason_str.replace("💥", "").strip() if reason_str else reason_str

        # Extra numeric columns requested by user:
        # - actual score: parsed from failureMetadata actualScore when available, else from details text
        # - shortfall: parsed from failureMetadata scoreDifference when available, else from details text
        actual_score_val = (meta.get("actualScore") or "").strip() if meta else ""
        shortfall_val = (meta.get("scoreDifference") or "").strip() if meta else ""

        if not actual_score_val:
            m = actual_score_re.search(details or "")
            if m:
                actual_score_val = m.group(1).strip()

        if not shortfall_val:
            m = shortfall_re.search(details or "")
            if m:
                shortfall_val = m.group(1).strip()

        row: dict = {
            "time": log_time,
            "msisdn": msisdn or "",
            "sessionid": session_id or "",
            "errorCode": code_str,
            "reason": reason_str,
            "details": details,
            "actual score": actual_score_val,
            "shortfall": shortfall_val,
            "scoreThreshold": score_threshold,
        }
        report_rows_append(row)

    report = pd.DataFrame(report_rows)
    if not report.empty:
        # Format-agnostic event dedupe:
        # raw and cleaned exports can differ in MSISDN presence/formatting,
        # but session + reason/error + threshold identifies the same failure event.
        report = report.drop_duplicates(
            subset=REPORT_DEDUPE_FIELDS,
            keep="first",
        ).reset_index(drop=True)
        report = drop_async_process_duplicates(report)
        report = drop_semantic_duplicates(report)
    report = report.reindex(
        columns=[
            "time",
            "msisdn",
            "sessionid",
            "errorCode",
            "reason",
            "details",
            "actual score",
            "shortfall",
            "scoreThreshold",
        ]
    )
    report["time"] = report["time"].astype(str)
    report["msisdn"] = report["msisdn"].astype(str)
    report["sessionid"] = report["sessionid"].astype(str)
    report["scoreThreshold"] = report["scoreThreshold"].astype(str)

    VIEWER_APP_PUBLIC.mkdir(parents=True, exist_ok=True)
    outp = output_path()
    report.to_csv(outp, index=False)
    out_abs = outp.resolve()
    print(f"Rows from filtered log: {len(df_err)}")
    print(f"Report rows: {len(report)}")
    if os.environ.get("REPORT_VERBOSE_SAMPLE", "").strip() == "1":
        print("Sample:")
        try:
            print(report.head(10).to_string(index=False))
        except UnicodeEncodeError:
            print(report.head(10).to_string(index=False).encode("cp1252", errors="replace").decode("cp1252"))
    print(f"Written: {out_abs}")

if __name__ == "__main__":
    main()