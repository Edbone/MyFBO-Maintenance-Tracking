require("dotenv").config();

const { chromium, firefox, webkit } = require("playwright");
const { analyzeAircraft } = require("./analyzer");
const { appendLog, readState, writeState } = require("./storage");

const SELECTORS = {
  username: [
    'input[name="username"]',
    'input[name="userid"]',
    'input[name="user"]',
    'input[type="text"]'
  ],
  password: [
    'input[name="password"]',
    'input[name="passwd"]',
    'input[type="password"]'
  ],
  submit: [
    'button[type="submit"]',
    'input[type="submit"]',
    'button:has-text("Login")',
    'button:has-text("Log In")'
  ],
  maintenanceNav: [
    'a[href*="maintenance"]',
    'button[data-section="maintenance"]',
    'a:has-text("Maintenance")'
  ],
  maintenanceTable: ["table"],
  maintenanceRows: ["table tbody tr"]
};

function log(level, message) {
  const line = `[${level.toUpperCase()}] ${message}`;
  console.log(line);
  appendLog(line);
}

function getBrowserType() {
  switch ((process.env.PLAYWRIGHT_BROWSER || "chromium").toLowerCase()) {
    case "firefox":
      return firefox;
    case "webkit":
      return webkit;
    default:
      return chromium;
  }
}

function getVendor() {
  return (process.env.FBO_VENDOR || "").trim().toLowerCase();
}

function isHeadlessEnabled() {
  return String(process.env.PLAYWRIGHT_HEADLESS || "true").toLowerCase() !== "false";
}

function getViewport() {
  const width = Number(process.env.PLAYWRIGHT_VIEWPORT_WIDTH || 1440);
  const height = Number(process.env.PLAYWRIGHT_VIEWPORT_HEIGHT || 1200);
  return {
    width: Number.isFinite(width) ? width : 1440,
    height: Number.isFinite(height) ? height : 1200
  };
}

function assertConfig() {
  if (String(process.env.MOCK_MODE).toLowerCase() === "true") {
    return;
  }

  const required = [
    "FBO_LOGIN_URL",
    "FBO_USERNAME",
    "FBO_PASSWORD"
  ];

  const missing = required.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  }
}

async function firstVisibleLocator(page, selectors, options = {}) {
  const timeout = options.timeout || Number(process.env.SCRAPE_TIMEOUT_MS || 45000);
  const state = options.state || "visible";

  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    try {
      await locator.waitFor({ state, timeout: Math.min(timeout, 5000) });
      return locator;
    } catch (_error) {
      // Try the next selector.
    }
  }

  throw new Error(`Unable to find a visible element using selectors: ${selectors.join(", ")}`);
}

async function clickByText(page, text, role = "link") {
  const exact = page.getByRole(role, { name: new RegExp(`^${text}$`, "i") }).first();
  try {
    await exact.waitFor({ state: "visible", timeout: 4000 });
    await exact.click();
    return true;
  } catch (_error) {
    const partial = page.getByText(new RegExp(text, "i")).first();
    try {
      await partial.waitFor({ state: "visible", timeout: 4000 });
      await partial.click();
      return true;
    } catch (_innerError) {
      return false;
    }
  }
}

async function captureDebugArtifacts(page, label) {
  const snapshot = await page.content();
  appendLog(`[DEBUG] ${label} HTML snapshot length=${snapshot.length}`);
  try {
    const safeLabel = label.replace(/[^a-z0-9_-]/gi, "_").toLowerCase();
    const state = readState();
    const dataDir = process.env.DATA_DIR || "./data";
    const fs = require("fs");
    const path = require("path");
    fs.mkdirSync(path.resolve(dataDir, "debug"), { recursive: true });
    const htmlPath = path.resolve(dataDir, "debug", `${safeLabel}.html`);
    fs.writeFileSync(htmlPath, snapshot);
    appendLog(`[DEBUG] Saved debug HTML to ${htmlPath}`);
    if (state && state.lastSuccessfulUpdate) {
      appendLog(`[DEBUG] Last successful update still available from ${state.lastSuccessfulUpdate}`);
    }
  } catch (error) {
    appendLog(`[WARN] Failed to save debug artifacts: ${error.message}`);
  }
}

function generateMockAircraft() {
  const mock = [
    {
      tailNumber: "N12345",
      currentTime: 3492.1,
      last100Hour: 3410.2,
      next100HourDue: 3510.2,
      warnings: ["Upcoming 100-hour due soon"]
    },
    {
      tailNumber: "N23456",
      currentTime: 4122.4,
      last100Hour: 4040.0,
      next100HourDue: 4140.0,
      warnings: []
    },
    {
      tailNumber: "N34567",
      currentTime: 2987.6,
      last100Hour: 2890.3,
      next100HourDue: 2990.3,
      warnings: ["Inspection nearly due"]
    },
    {
      tailNumber: "N45678",
      currentTime: 5205.2,
      last100Hour: 5110.2,
      next100HourDue: 5210.2,
      warnings: ["Overdue maintenance"]
    }
  ];

  return mock.map((item) => ({
    ...item,
    hoursRemaining: Number((item.next100HourDue - item.currentTime).toFixed(1))
  }));
}

async function safeGoto(page, url) {
  await page.goto(url, {
    waitUntil: "domcontentloaded",
    timeout: Number(process.env.SCRAPE_TIMEOUT_MS || 45000)
  });
}

async function loginToFbo(page) {
  log("info", "Opening FBO login page");
  await safeGoto(page, process.env.FBO_LOGIN_URL);

  if (getVendor() === "myfbo" && process.env.MYFBO_ORG_ID) {
    const textBoxes = page.locator('input[type="text"], input:not([type])');
    const textBoxCount = await textBoxes.count();
    if (textBoxCount > 0) {
      log("info", "Submitting MyFBO organization identifier");
      await textBoxes.first().fill(process.env.MYFBO_ORG_ID);
      const submit = await firstVisibleLocator(page, SELECTORS.submit);
      await submit.click();
      await page.waitForLoadState("domcontentloaded", {
        timeout: Number(process.env.SCRAPE_TIMEOUT_MS || 45000)
      });
    }
  }

  // Update these selectors if your subscriber login page uses different field names.
  const username = await firstVisibleLocator(page, SELECTORS.username);
  const password = await firstVisibleLocator(page, SELECTORS.password);
  const submit = await firstVisibleLocator(page, SELECTORS.submit);

  await username.fill(process.env.FBO_USERNAME);
  await password.fill(process.env.FBO_PASSWORD);
  await submit.click();

  await page.waitForLoadState("networkidle", {
    timeout: Number(process.env.SCRAPE_TIMEOUT_MS || 45000)
  });
}

async function navigateMyFboMaintenance(page) {
  log("info", "Navigating MyFBO maintenance flow");

  const openedManage = await clickByText(page, "Manage", "link");
  if (!openedManage) {
    await clickByText(page, "Manage", "button");
  }
  await page.waitForLoadState("networkidle", {
    timeout: Number(process.env.SCRAPE_TIMEOUT_MS || 45000)
  });

  const openedMaintenance = await clickByText(page, "Maintenance", "link");
  if (!openedMaintenance) {
    const nav = await firstVisibleLocator(page, SELECTORS.maintenanceNav);
    await nav.click();
  }
  await page.waitForLoadState("networkidle", {
    timeout: Number(process.env.SCRAPE_TIMEOUT_MS || 45000)
  });

  const allOption = page.locator('select').filter({ has: page.locator('option') }).first();
  try {
    await allOption.waitFor({ state: "visible", timeout: 6000 });
    const optionTexts = await allOption.locator("option").allTextContents();
    const allValue = optionTexts.find((text) => /all aircraft/i.test(text));
    if (allValue) {
      await allOption.selectOption({ label: allValue.trim() });
      log("info", 'Selected "All Aircraft" report option');
    }
  } catch (_error) {
    log("warn", "Could not auto-select the MyFBO aircraft dropdown; continuing");
  }

  const reportType = (process.env.MYFBO_REPORT_TYPE || "summary").toLowerCase();
  const clickedReport =
    (await clickByText(page, reportType === "detailed" ? "Detailed" : "Summary", "button")) ||
    (await clickByText(page, reportType === "detailed" ? "Detailed" : "Summary", "link"));

  if (!clickedReport) {
    throw new Error("Unable to open the MyFBO maintenance status report");
  }

  await page.waitForLoadState("networkidle", {
    timeout: Number(process.env.SCRAPE_TIMEOUT_MS || 45000)
  });
}

async function navigateToMaintenance(page) {
  if (process.env.FBO_MAINTENANCE_URL) {
    log("info", "Opening maintenance page directly");
    await safeGoto(page, process.env.FBO_MAINTENANCE_URL);
    return;
  }

  if (getVendor() === "myfbo") {
    await navigateMyFboMaintenance(page);
    return;
  }

  // If your site requires menu navigation, update this selector or replace the flow entirely.
  const nav = await firstVisibleLocator(page, SELECTORS.maintenanceNav);
  await nav.click();
  await page.waitForLoadState("networkidle", {
    timeout: Number(process.env.SCRAPE_TIMEOUT_MS || 45000)
  });
}

function normalizeHeader(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function mapColumns(headers) {
  const mapped = {};
  headers.forEach((header, index) => {
    const normalized = normalizeHeader(header);
    if (!mapped.tailNumber && /(tail|n-number|n number|aircraft|registration)/i.test(normalized)) {
      mapped.tailNumber = index;
    }
    if (!mapped.currentTime && /(hobbs|tach|current|airframe time|time)/i.test(normalized)) {
      mapped.currentTime = index;
    }
    if (!mapped.last100Hour && /(last 100|100 hour done|100hr done|last insp)/i.test(normalized)) {
      mapped.last100Hour = index;
    }
    if (!mapped.next100HourDue && /(next 100|100 hour due|due at|due next|next due)/i.test(normalized)) {
      mapped.next100HourDue = index;
    }
    if (!mapped.hoursRemaining && /(remaining|remain|hrs left|hours left|to run|due in)/i.test(normalized)) {
      mapped.hoursRemaining = index;
    }
    if (!mapped.warnings && /(warning|status|limit|notes|exceptions)/i.test(normalized)) {
      mapped.warnings = index;
    }
  });
  return mapped;
}

function extractFromTable(table) {
  const headers = table.headers || [];
  const columnMap = mapColumns(headers);
  return (table.rows || [])
    .map((cells) => ({
      tailNumber: cells[columnMap.tailNumber] || cells[0] || "",
      currentTime: columnMap.currentTime !== undefined ? cells[columnMap.currentTime] : null,
      last100Hour: columnMap.last100Hour !== undefined ? cells[columnMap.last100Hour] : null,
      next100HourDue: columnMap.next100HourDue !== undefined ? cells[columnMap.next100HourDue] : null,
      hoursRemaining: columnMap.hoursRemaining !== undefined ? cells[columnMap.hoursRemaining] : null,
      warnings: [
        columnMap.warnings !== undefined ? cells[columnMap.warnings] : null,
        ...cells.filter((cell) => /overdue|warning|due|limit/i.test(String(cell || "")))
      ].filter(Boolean)
    }))
    .filter((row) => row.tailNumber && /n[0-9a-z-]+|[a-z0-9-]{3,}/i.test(row.tailNumber));
}

async function extractAircraftData(page) {
  await firstVisibleLocator(page, SELECTORS.maintenanceTable, {
    state: "visible",
    timeout: Number(process.env.SCRAPE_TIMEOUT_MS || 45000)
  });

  const tables = await page.locator("table").evaluateAll((elements) =>
    elements.map((table) => {
      const headerCells = Array.from(table.querySelectorAll("th")).map((cell) =>
        cell.textContent.trim().replace(/\s+/g, " ")
      );
      const rowElements = Array.from(table.querySelectorAll("tr"));
      const rows = rowElements
        .map((row) =>
          Array.from(row.querySelectorAll("td")).map((cell) =>
            cell.textContent.trim().replace(/\s+/g, " ")
          )
        )
        .filter((cells) => cells.length > 0);

      return { headers: headerCells, rows };
    })
  );

  const aircraft = tables.flatMap(extractFromTable);
  if (aircraft.length > 0) {
    return aircraft;
  }

  if (getVendor() === "myfbo") {
    const textDump = await page.locator("body").innerText();
    const extracted = Array.from(
      textDump.matchAll(/(N[0-9A-Z-]{3,})[\s\S]{0,160}?(?:due|remaining|left)\D{0,12}(-?\d+(?:\.\d+)?)/gi)
    ).map((match) => ({
      tailNumber: match[1],
      currentTime: null,
      last100Hour: null,
      next100HourDue: null,
      hoursRemaining: match[2],
      warnings: []
    }));

    if (extracted.length > 0) {
      return extracted;
    }
  }

  await captureDebugArtifacts(page, "extract-aircraft-data-failed");
  throw new Error("Unable to extract aircraft maintenance data from the current page");
}

async function runLiveScrape() {
  const browserType = getBrowserType();
  const headless = isHeadlessEnabled();
  log(
    "info",
    `Launching ${process.env.PLAYWRIGHT_BROWSER || "chromium"} in ${headless ? "headless" : "headed"} mode`
  );
  const browser = await browserType.launch({
    headless,
    args: headless ? [] : [`--window-size=${getViewport().width},${getViewport().height}`]
  });

  try {
    const context = await browser.newContext({
      viewport: getViewport()
    });
    const page = await context.newPage();
    await loginToFbo(page);
    await navigateToMaintenance(page);
    return await extractAircraftData(page);
  } finally {
    await browser.close();
  }
}

async function runScrape() {
  assertConfig();
  const startedAt = Date.now();
  const previousState = readState();
  const mockMode = String(process.env.MOCK_MODE).toLowerCase() === "true";

  try {
    log("info", `Starting maintenance scrape (${mockMode ? "mock mode" : "live mode"})`);
    const aircraft = mockMode ? generateMockAircraft() : await runLiveScrape();
    const analysis = analyzeAircraft(aircraft);

    const nextState = {
      status: "ok",
      source: mockMode ? "mock" : "live",
      lastAttemptedUpdate: new Date().toISOString(),
      lastSuccessfulUpdate: new Date().toISOString(),
      runDurationMs: Date.now() - startedAt,
      error: null,
      data: analysis.aircraft,
      analysis
    };

    writeState(nextState);
    log("info", `Maintenance scrape completed successfully for ${analysis.aircraft.length} aircraft`);
    return nextState;
  } catch (error) {
    const failedState = {
      ...previousState,
      status: "error",
      source: previousState.source || (mockMode ? "mock" : "live"),
      lastAttemptedUpdate: new Date().toISOString(),
      runDurationMs: Date.now() - startedAt,
      error: error.message
    };

    writeState(failedState);
    log("error", `Maintenance scrape failed: ${error.message}`);
    throw error;
  }
}

if (require.main === module) {
  runScrape().catch(() => {
    process.exitCode = 1;
  });
}

module.exports = {
  SELECTORS,
  generateMockAircraft,
  runScrape
};
