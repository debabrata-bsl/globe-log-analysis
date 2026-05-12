import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { platform } from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const INLINE_REPORT_CSV_MAX_BYTES = 2 * 1024 * 1024;
let cachedPythonCmd = null;

function projectRoot() {
  return resolve(__dirname, "..", "..");
}

function pickPython() {
  if (cachedPythonCmd) return cachedPythonCmd;
  const ok = (cmd, args) =>
    spawnSync(cmd, args, { encoding: "utf8" }).status === 0;

  if (platform() === "win32") {
    if (ok("py", ["-3", "-c", "import pandas"])) cachedPythonCmd = "py";
    else if (ok("python", ["-c", "import pandas"])) cachedPythonCmd = "python";
    else if (ok("python3", ["-c", "import pandas"])) cachedPythonCmd = "python3";
    else cachedPythonCmd = "python";
    return cachedPythonCmd;
  }
  if (ok("python3", ["-c", "import pandas"])) cachedPythonCmd = "python3";
  else if (ok("python", ["-c", "import pandas"])) cachedPythonCmd = "python";
  else cachedPythonCmd = "python3";
  return cachedPythonCmd;
}

function pythonSpawnArgs(root) {
  const script = join(root, "scripts", "build_error_report.py");
  const py = pickPython();
  if (platform() === "win32" && py === "py") return { cmd: py, args: ["-3", script] };
  return { cmd: py, args: [script] };
}

function pythonSpawnArgsFor(root, scriptName) {
  const script = join(root, "scripts", scriptName);
  const py = pickPython();
  if (platform() === "win32" && py === "py") return { cmd: py, args: ["-3", script] };
  return { cmd: py, args: [script] };
}

function pathOnly(url) {
  if (!url) return "";
  const q = url.indexOf("?");
  return q === -1 ? url : url.slice(0, q);
}

function readJsonBody(req, res, done) {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    let body;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      res.statusCode = 400;
      res.end(JSON.stringify({ ok: false, error: "Invalid JSON body" }));
      return;
    }
    done(body);
  });
}

function runReportMiddleware(req, res) {
  if (req.method !== "POST" || pathOnly(req.url) !== "/api/run-report") {
    res.statusCode = 404;
    res.end();
    return;
  }

  readJsonBody(req, res, (body) => {
    const files = body && Array.isArray(body.files) ? body.files : [];
    const returnReportCsv = Boolean(body && body.returnReportCsv);
    if (!files.length) {
      res.statusCode = 400;
      res.end(JSON.stringify({ ok: false, error: "No files in request" }));
      return;
    }

    const root = projectRoot();
    const tmpBase = join(root, ".tmp-report-build");
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const workDir = join(tmpBase, stamp);

    try {
      mkdirSync(workDir, { recursive: true });
      files.forEach((f, i) => {
        const name = typeof f.name === "string" ? f.name : `upload-${i}.csv`;
        const content = typeof f.content === "string" ? f.content : "";
        writeFileSync(join(workDir, `input_${i}.csv`), content, "utf8");
      });

      const { cmd, args } = pythonSpawnArgs(root);
      const outputName = "in_memory_report.csv";

      const env = { ...process.env, LOG_CSV_DIR: workDir, REPORT_OUTPUT_NAME: outputName };
      const proc = spawnSync(cmd, args, {
        cwd: workDir,
        env,
        encoding: "utf8",
        maxBuffer: 512 * 1024 * 1024,
      });

      if (proc.status !== 0) {
        res.statusCode = 500;
        res.end(
          JSON.stringify({
            ok: false,
            error: proc.stderr || proc.stdout || `Python exited with code ${proc.status}`,
          })
        );
        return;
      }

      const reportPath = join(workDir, "viewer-app", "public", outputName);
      if (!existsSync(reportPath)) {
        res.statusCode = 500;
        res.end(
          JSON.stringify({
            ok: false,
            error: "Report build finished but no CSV output was found.",
          })
        );
        return;
      }

      const reportStat = statSync(reportPath);
      const shouldInline = returnReportCsv || reportStat.size <= INLINE_REPORT_CSV_MAX_BYTES;
      const inlineReportCsv = shouldInline ? readFileSync(reportPath, "utf8") : "";
      res.statusCode = 200;
      res.end(
        JSON.stringify({
          ok: true,
          reportCsv: inlineReportCsv,
          reportCsvInlined: Boolean(inlineReportCsv),
          stdout: proc.stdout || "",
        })
      );
    } catch (e) {
      res.statusCode = 500;
      res.end(
        JSON.stringify({
          ok: false,
          error: e && e.message ? e.message : String(e),
        })
      );
    } finally {
      try {
        rmSync(workDir, { recursive: true, force: true });
      } catch { /* ignore */ }
      try {
        if (existsSync(tmpBase) && readdirSync(tmpBase).length === 0) {
          rmSync(tmpBase, { recursive: true, force: true });
        }
      } catch { /* ignore */ }
    }
  });
}

function runMsisdnReportMiddleware(req, res) {
  if (req.method !== "POST" || pathOnly(req.url) !== "/api/run-msisdn-report") {
    res.statusCode = 404;
    res.end();
    return;
  }

  readJsonBody(req, res, (body) => {
    const files = body && Array.isArray(body.files) ? body.files : [];
    const msisdnFile = body && body.msisdnFile ? body.msisdnFile : null;
    const returnReportCsv = Boolean(body && body.returnReportCsv);
    if (!files.length) {
      res.statusCode = 400;
      res.end(JSON.stringify({ ok: false, error: "No log files in request" }));
      return;
    }
    const root = projectRoot();
    const tmpBase = join(root, ".tmp-report-build");
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const workDir = join(tmpBase, stamp);

    try {
      mkdirSync(workDir, { recursive: true });
      files.forEach((f, i) => {
        const name = typeof f.name === "string" ? f.name : `upload-${i}.csv`;
        const content = typeof f.content === "string" ? f.content : "";
        writeFileSync(join(workDir, `input_${i}.csv`), content, "utf8");
      });

      const { cmd, args } = pythonSpawnArgsFor(root, "analyze_error_log_by_msisdn.py");
      let msisdnPath = "";
      let scriptArgs = [...args];
      if (msisdnFile && typeof msisdnFile.content === "string" && String(msisdnFile.content).trim()) {
        const msisdnName = typeof msisdnFile.name === "string" ? msisdnFile.name : "msisdn.csv";
        const msisdnSafe = msisdnName.replace(/[^\w.\-]/g, "_") || "msisdn.csv";
        msisdnPath = join(workDir, msisdnSafe);
        writeFileSync(msisdnPath, String(msisdnFile.content || ""), "utf8");
        scriptArgs = [...scriptArgs, "--msisdn-list", msisdnPath];
      }

      const outputName = "in_memory_msisdn_report.csv";
      const outputPath = join(workDir, outputName);
      scriptArgs = [...scriptArgs, "--output", outputPath];
      const env = {
        ...process.env,
        LOG_CSV_DIR: workDir,
        MSISDN_FILTER_FILE: msisdnPath,
        RUN_MSISDN_REPORT_MODE: "1",
        REPORT_OUTPUT_NAME: outputName,
      };
      const proc = spawnSync(cmd, scriptArgs, {
        cwd: workDir,
        env,
        encoding: "utf8",
        maxBuffer: 512 * 1024 * 1024,
      });

      if (proc.status !== 0) {
        res.statusCode = 500;
        res.end(
          JSON.stringify({
            ok: false,
            error: proc.stderr || proc.stdout || `Python exited with code ${proc.status}`,
          })
        );
        return;
      }

      const reportPath = outputPath;
      if (!existsSync(reportPath)) {
        res.statusCode = 500;
        res.end(
          JSON.stringify({
            ok: false,
            error: "MSISDN report build finished but no CSV output was found.",
          })
        );
        return;
      }

      const reportStat = statSync(reportPath);
      const shouldInline = returnReportCsv || reportStat.size <= INLINE_REPORT_CSV_MAX_BYTES;
      const inlineReportCsv = shouldInline ? readFileSync(reportPath, "utf8") : "";
      res.statusCode = 200;
      res.end(
        JSON.stringify({
          ok: true,
          reportCsv: inlineReportCsv,
          reportCsvInlined: Boolean(inlineReportCsv),
          stdout: proc.stdout || "",
        })
      );
    } catch (e) {
      res.statusCode = 500;
      res.end(
        JSON.stringify({
          ok: false,
          error: e && e.message ? e.message : String(e),
        })
      );
    } finally {
      try {
        rmSync(workDir, { recursive: true, force: true });
      } catch { /* ignore */ }
      try {
        if (existsSync(tmpBase) && readdirSync(tmpBase).length === 0) {
          rmSync(tmpBase, { recursive: true, force: true });
        }
      } catch { /* ignore */ }
    }
  });
}

export function runReportPlugin() {
  return {
    name: "run-report-api",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.method === "POST" && pathOnly(req.url) === "/api/run-report") {
          runReportMiddleware(req, res);
          return;
        }
        if (req.method === "POST" && pathOnly(req.url) === "/api/run-msisdn-report") {
          runMsisdnReportMiddleware(req, res);
          return;
        }
        next();
      });
    },
  };
}
