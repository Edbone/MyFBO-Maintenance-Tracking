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

function getMyFboReportType() {
  return (process.env.MYFBO_REPORT_TYPE || "summary").toLowerCase();
}

function getMyFboBaseFilter() {
  return (process.env.MYFBO_BASE_FILTER || process.env.MYFBO_AIRPORT || "").trim().toUpperCase();
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

async function waitForFrame(page, selector) {
  const locator = page.locator(selector).first();
  await locator.waitFor({
    state: "attached",
    timeout: Number(process.env.SCRAPE_TIMEOUT_MS || 45000)
  });
  const frame = await locator.contentFrame();
  if (!frame) {
    throw new Error(`Unable to access frame for selector: ${selector}`);
  }
  return frame;
}

async function waitForMyFboReport(page, reportType) {
  const expectedText =
    reportType === "detailed"
      ? "Aircraft Maintenance Status Detailed"
      : "Aircraft Maintenance Status Summary";
  const secondaryText = reportType === "detailed" ? "Maintenance Items" : "DO NOT FLY";

  try {
    await page.waitForFunction(
      ({ expected, secondary }) => {
        const appFrame = document.querySelector("#myfbo2");
        const appWindow = appFrame && appFrame.contentWindow;
        const workAreaFrame = appWindow && appWindow.frames && appWindow.frames.wa;
        const bodyText = workAreaFrame?.document?.body?.innerText || "";
        return bodyText.includes(expected) && bodyText.includes(secondary);
      },
      { expected: expectedText, secondary: secondaryText },
      { timeout: Math.min(Number(process.env.SCRAPE_TIMEOUT_MS || 45000), 12000) }
    );
  } catch (_error) {
    await page.waitForTimeout(reportType === "detailed" ? 12000 : 4000);
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

  if (getVendor() === "myfbo" && /entry\.asp/i.test(process.env.FBO_LOGIN_URL || "")) {
    log("info", "Following recorded MyFBO entry flow");
    const mainFrame = await waitForFrame(page, 'frame[name="main"]');
    await mainFrame.getByRole("link", { name: /online system/i }).click();

    const appFrame = page.frameLocator("#myfbo2");
    await appFrame.locator('input[name="email"]').waitFor({
      state: "visible",
      timeout: Number(process.env.SCRAPE_TIMEOUT_MS || 45000)
    });
    await appFrame.locator('input[name="email"]').fill(process.env.FBO_USERNAME);
    await appFrame.locator('input[name="password"]').fill(process.env.FBO_PASSWORD);
    await appFrame.getByRole("button", { name: /log in/i }).click();
    return;
  }

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

  if (/entry\.asp/i.test(process.env.FBO_LOGIN_URL || "")) {
    const appFrame = page.frameLocator("#myfbo2");
    const topFrame = appFrame.frameLocator('frame[name="tf"]');
    await topFrame.getByRole("cell", { name: "Manage", exact: true }).click();
    await topFrame.getByRole("link", { name: /resource\s*mgmt/i }).click();
    await topFrame.getByRole("link", { name: /maintenance/i }).click();

    const workAreaFrame = appFrame.frameLocator('frame[name="wa"]');
    const airportCode = (process.env.MYFBO_AIRPORT || "").trim();
    if (airportCode) {
      const airportSelect = workAreaFrame.locator('select[name="apt"]').first();
      await airportSelect.waitFor({
        state: "visible",
        timeout: Number(process.env.SCRAPE_TIMEOUT_MS || 45000)
      });
      await airportSelect.selectOption(airportCode);
      log("info", `Selected MyFBO airport ${airportCode}`);
    }

    await workAreaFrame
      .getByRole("button", { name: new RegExp(getMyFboReportType(), "i") })
      .click();
    await waitForMyFboReport(page, getMyFboReportType());
    return;
  }

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

  const clickedReport =
    (await clickByText(page, getMyFboReportType() === "detailed" ? "Detailed" : "Summary", "button")) ||
    (await clickByText(page, getMyFboReportType() === "detailed" ? "Detailed" : "Summary", "link"));

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

function parseMyFboSummaryReport(text) {
  const sections = [];
  const normalized = String(text || "").replace(/\r/g, "");
  const sectionRegex =
    /(?:^|\n)(N[0-9A-Z-]{2,})\n([^\n]+)\s*\nItem Name[\s\S]*?DO NOT FLY\s+\1\s+BEYOND([\s\S]*?)(?=\nN[0-9A-Z-]{2,}\n[^\n]+\s*\nItem Name|\s*$)/gi;

  for (const match of normalized.matchAll(sectionRegex)) {
    const tailNumber = match[1].trim();
    const aircraftType = match[2].trim();
    const block = `${tailNumber}\n${aircraftType}\n${match[3]}`;

    const currentTimeMatch = block.match(/Next Tach-Based Items\s+from\s+(\d+(?:\.\d+)?)/i);
    const tachLimitMatch = block.match(/(?:^|\n)\s*Tach\s+(\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+hrs/mi);
    const inspectionMatch = block.match(
      /(?:^|\n)\s*100hr Inspection\s+(\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+hrs/mi
    );

    const warnings = [];
    if (block.match(/100hr Inspection\s+\d+(?:\.\d+)?\s+-\d+(?:\.\d+)?\s+hrs/i)) {
      warnings.push("100-hour inspection overdue");
    }
    if (block.match(/Annual Inspection\s+[0-9/.-]+\s+-\d+\s+days/i)) {
      warnings.push("Annual inspection overdue");
    }

    const next100HourDue = inspectionMatch ? inspectionMatch[1] : null;
    const hoursRemaining = inspectionMatch ? inspectionMatch[2] : null;
    const currentTime = currentTimeMatch ? currentTimeMatch[1] : null;
    const last100Hour =
      next100HourDue !== null ? (Number(next100HourDue) - 100).toFixed(1) : null;

    sections.push({
      tailNumber,
      aircraftType,
      currentTime,
      last100Hour,
      next100HourDue,
      hoursRemaining,
      warnings,
      doNotFlyTach: tachLimitMatch ? tachLimitMatch[1] : null,
      doNotFlyTachRemaining: tachLimitMatch ? tachLimitMatch[2] : null
    });
  }

  return sections;
}

function parseMyFboAircraftIndex(text) {
  const aircraftIndex = new Map();
  for (const match of String(text || "").matchAll(/(N[0-9A-Z-]{2,})\s*-\s*([A-Z0-9_]+)\s*\(([^)]+)\)/g)) {
    aircraftIndex.set(match[1], {
      tailNumber: match[1],
      aircraftType: match[2],
      base: match[3]
    });
  }
  return aircraftIndex;
}

function parseRemainingValue(value) {
  const match = String(value || "").match(/(-?\d+(?:\.\d+)?)\s*(hours|days)/i);
  if (!match) {
    return { value: null, unit: null };
  }
  return {
    value: Number(match[1]),
    unit: match[2].toLowerCase()
  };
}

function parseDueDescriptor(value) {
  const matches = Array.from(String(value || "").matchAll(/\b(TTach|Tach|Date)\s+([0-9./~]+)/gi));
  if (matches.length === 0) {
    return { basis: null, due: null };
  }
  const last = matches[matches.length - 1];
  return {
    basis: last[1],
    due: last[2]
  };
}

function parseMyFboDetailedItems(block) {
  const itemsSectionMatch = block.match(
    /Maintenance Items[\s\S]*?Name[\s\S]*?\n([\s\S]*?)(?=\n\s*(?:Maintenance Scheduled|Unresolved Squawks|Recent Maintenance History|Full Maintenance History|Recent Squawks Resolved)\b|$)/i
  );

  if (!itemsSectionMatch) {
    return [];
  }

  const merged = itemsSectionMatch[1]
    .replace(/\r/g, "")
    .replace(/\n\s*(TTach|Tach|Date)\s+/g, " $1 ")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const categories = new Set([
    "Airworthiness Directive",
    "Engine",
    "Equipment",
    "Inspection",
    "Overhaul / Life Limited",
    "Other"
  ]);

  const items = [];
  let currentCategory = "Other";

  for (const line of merged) {
    if (categories.has(line)) {
      currentCategory = line;
      continue;
    }

    if (line.startsWith("‡") || line.includes("Not blocked on dispatch")) {
      continue;
    }

    const parts = line
      .split("\t")
      .map((part) => part.replace(/\s+/g, " ").trim())
      .filter(Boolean);

    if (parts.length < 3) {
      continue;
    }

    const remainingPart = parts[parts.length - 1];
    const duePart = parts[parts.length - 2];
    const lastPart = parts[parts.length - 3] || null;
    const comments = parts.length > 4 ? parts.slice(1, -3).join(" | ") : parts[1] || "";
    const { value: remainingValue, unit: remainingUnit } = parseRemainingValue(remainingPart);
    const { basis: nextBasis, due: nextDue } = parseDueDescriptor(duePart);
    const { basis: lastBasis, due: lastDue } = parseDueDescriptor(lastPart);

    items.push({
      category: currentCategory,
      name: parts[0],
      comments,
      lastBasis,
      lastDue,
      nextBasis,
      nextDue,
      remainingValue,
      remainingUnit,
      raw: line
    });
  }

  return items;
}

function parseMyFboScheduledMaintenance(block) {
  const sectionMatch = block.match(
    /Maintenance Scheduled[\s\S]*?From[\s\S]*?\n([\s\S]*?)(?=\n\s*(?:Unresolved Squawks|Recent Maintenance History|Full Maintenance History|Recent Squawks Resolved)\b|$)/i
  );

  if (!sectionMatch) {
    return [];
  }

  return sectionMatch[1]
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^\d{2}\/\d{2}\/\d{2}/.test(line))
    .map((line) => {
      const parts = line.split("\t").map((part) => part.replace(/\s+/g, " ").trim()).filter(Boolean);
      return {
        from: parts[0] || null,
        to: parts[1] || null,
        remarks: parts.slice(2).join(" | ") || null
      };
    });
}

function parseMyFboUnresolvedSquawks(block) {
  const sectionMatch = block.match(
    /Unresolved Squawks[\s\S]*?Date[\s\S]*?\n([\s\S]*?)(?=\n\s*(?:Recent Maintenance History|Recent Squawks Resolved|Full Maintenance History)\b|$)/i
  );

  if (!sectionMatch) {
    return [];
  }

  return sectionMatch[1]
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^\d{2}\/\d{2}\/\d{2}/.test(line))
    .map((line) => {
      const parts = line.split("\t").map((part) => part.replace(/\s+/g, " ").trim()).filter(Boolean);
      return {
        date: parts[0] || null,
        squawkNumber: parts[1] || null,
        hobbs: parts[2] || null,
        tach: parts[3] || null,
        status: parts[4] || null,
        description: parts.slice(5).join(" | ") || null
      };
    });
}

function isDeferredSquawk(squawk) {
  const status = String(squawk?.status || "").trim().toLowerCase();
  const description = String(squawk?.description || "").trim().toLowerCase();
  return status.includes("defer") || description.includes("deferred");
}

function parseMyFboDetailedReport(text) {
  const normalized = String(text || "").replace(/\r/g, "");
  const headerRegex = /(?:^|\n)(N[0-9A-Z-]{2,})\s+Type:\s+([^\n]+?)\s+Base:\s+([A-Z0-9]+)/g;
  const matches = Array.from(normalized.matchAll(headerRegex));

  return matches.map((match, index) => {
    const start = match.index;
    const end = index + 1 < matches.length ? matches[index + 1].index : normalized.length;
    const block = normalized.slice(start, end);
    const tailNumber = match[1].trim();
    const aircraftType = match[2].trim();
    const base = match[3].trim();
    const currentTime = block.match(/Computed Total Tach:\s*([0-9.]+)/i)?.[1] || null;
    const currentHobbs = block.match(/Computed Total Hobbs:\s*([0-9.]+)/i)?.[1] || null;
    const items = parseMyFboDetailedItems(block);
    const scheduledMaintenance = parseMyFboScheduledMaintenance(block);
    const unresolvedSquawks = parseMyFboUnresolvedSquawks(block);
    const activeSquawks = unresolvedSquawks.filter((item) => !isDeferredSquawk(item));
    const annualItem = items.find((item) => /annual inspection/i.test(item.name));
    const hundredHourItem = items.find(
      (item) => /\b100\s*hour\b|\b100hr\b/i.test(item.name) && !/\b1000\b/.test(item.name)
    );
    const warnings = [];

    if (annualItem?.remainingValue !== null && annualItem?.remainingUnit === "days" && annualItem.remainingValue < 0) {
      warnings.push("Annual inspection overdue");
    }
    if (
      hundredHourItem?.remainingValue !== null &&
      hundredHourItem?.remainingUnit === "hours" &&
      hundredHourItem.remainingValue < 0
    ) {
      warnings.push("100-hour inspection overdue");
    }
    if (activeSquawks.length > 0) {
      warnings.push(`${activeSquawks.length} open squawk${activeSquawks.length === 1 ? "" : "s"}`);
    }
    if (scheduledMaintenance.length > 0) {
      warnings.push("Scheduled maintenance in progress or upcoming");
    }

    return {
      tailNumber,
      aircraftType,
      base,
      currentTime,
      currentHobbs,
      last100Hour:
        hundredHourItem?.nextDue && hundredHourItem?.remainingUnit === "hours"
          ? (Number(hundredHourItem.nextDue) - 100).toFixed(1)
          : null,
      next100HourDue: hundredHourItem?.nextDue || null,
      hoursRemaining:
        hundredHourItem?.remainingUnit === "hours" ? hundredHourItem.remainingValue : null,
      annualDueDate: annualItem?.nextDue || null,
      annualDaysRemaining:
        annualItem?.remainingUnit === "days" ? annualItem.remainingValue : null,
      maintenanceItems: items,
      unresolvedSquawks,
      scheduledMaintenance,
      warnings
    };
  });
}

function applyMyFboBaseFilter(aircraft) {
  const baseFilter = getMyFboBaseFilter();
  if (!baseFilter) {
    return aircraft;
  }

  return aircraft.filter((item) => String(item.base || "").toUpperCase() === baseFilter);
}

async function extractAircraftData(page) {
  if (getVendor() === "myfbo" && /entry\.asp/i.test(process.env.FBO_LOGIN_URL || "")) {
    const workAreaFrame = page.frameLocator("#myfbo2").frameLocator('frame[name="wa"]');
    return await extractAircraftDataFromContext(workAreaFrame, page, "myfbo-workarea");
  }

  return await extractAircraftDataFromContext(page, page, "page");
}

async function extractAircraftDataFromContext(context, debugPage, debugLabel) {
  if (getVendor() === "myfbo") {
    const textDump = await context.locator("body").innerText();
    const parsedDetailed = parseMyFboDetailedReport(textDump);
    if (parsedDetailed.length > 0) {
      return applyMyFboBaseFilter(parsedDetailed);
    }

    const parsedSummary = parseMyFboSummaryReport(textDump);
    if (parsedSummary.length > 0) {
      const aircraftIndex = parseMyFboAircraftIndex(textDump);
      const enriched = parsedSummary.map((entry) => ({
        ...aircraftIndex.get(entry.tailNumber),
        ...entry
      }));
      return applyMyFboBaseFilter(enriched);
    }
  }

  await firstVisibleLocator(context, SELECTORS.maintenanceTable, {
    state: "visible",
    timeout: Number(process.env.SCRAPE_TIMEOUT_MS || 45000)
  });

  const tables = await context.locator("table").evaluateAll((elements) =>
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
    return applyMyFboBaseFilter(aircraft);
  }

  if (getVendor() === "myfbo") {
    const textDump = await context.locator("body").innerText();
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

  await captureDebugArtifacts(debugPage, `extract-aircraft-data-failed-${debugLabel}`);
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
