const fs = require("fs");
const path = require("path");

const DEFAULT_STATE = {
  status: "unknown",
  source: "none",
  lastAttemptedUpdate: null,
  lastSuccessfulUpdate: null,
  runDurationMs: null,
  error: null,
  data: [],
  analysis: null
};

function resolveDataDir() {
  return path.resolve(process.env.DATA_DIR || path.join(process.cwd(), "data"));
}

function ensureDataLayout() {
  const dataDir = resolveDataDir();
  const logsDir = path.join(dataDir, "logs");
  fs.mkdirSync(logsDir, { recursive: true });
  return {
    dataDir,
    logsDir,
    statePath: path.join(dataDir, "maintenance-state.json")
  };
}

function readState() {
  const { statePath } = ensureDataLayout();
  if (!fs.existsSync(statePath)) {
    return { ...DEFAULT_STATE };
  }

  try {
    const raw = fs.readFileSync(statePath, "utf8");
    return { ...DEFAULT_STATE, ...JSON.parse(raw) };
  } catch (error) {
    return {
      ...DEFAULT_STATE,
      status: "error",
      error: `Failed to parse state file: ${error.message}`
    };
  }
}

function writeJsonAtomic(targetPath, value) {
  const tempPath = `${targetPath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(value, null, 2));
  fs.renameSync(tempPath, targetPath);
}

function writeState(nextState) {
  const { statePath } = ensureDataLayout();
  writeJsonAtomic(statePath, nextState);
  return nextState;
}

function appendLog(message) {
  const { logsDir } = ensureDataLayout();
  const dateKey = new Date().toISOString().slice(0, 10);
  const logPath = path.join(logsDir, `${dateKey}.log`);
  fs.appendFileSync(logPath, `${new Date().toISOString()} ${message}\n`);
}

module.exports = {
  DEFAULT_STATE,
  ensureDataLayout,
  readState,
  writeState,
  appendLog
};
