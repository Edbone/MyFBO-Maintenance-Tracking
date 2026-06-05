# Self-Hosted Flight School Maintenance Tracker

This project provides a secure self-hosted maintenance tracking automation system for flight school aircraft. It logs into your FBO system with Playwright, captures maintenance data, stores the latest known good snapshot as JSON, analyzes 100-hour inspection spacing risk, and serves an iframe-friendly dashboard with optional basic auth.

## Features

- Debian-friendly Node.js service
- Playwright automation with support for both headless and virtual-display headed mode
- Credentials loaded from environment variables only
- Mock mode for local testing without touching the FBO site
- JSON snapshot storage with last successful update retention
- Run logs saved locally per day
- `/api/maintenance` JSON endpoint
- `/dashboard` responsive embeddable dashboard
- Optional HTTP Basic Auth for API and dashboard
- systemd service and timer examples

## Project Layout

- `src/scraper.js`: FBO login, navigation, extraction, mock mode
- `src/storage.js`: JSON state persistence and run logs
- `src/analyzer.js`: Hours-remaining analysis, color status, spacing-risk logic
- `src/server.js`: Express API and dashboard server
- `public/dashboard.html`: iframe-friendly frontend
- `public/styles.css`: dashboard styling
- `systemd/maintenance-tracker.service`: service example
- `systemd/maintenance-tracker.timer`: timer example
- `systemd/maintenance-tracker-scrape.service`: oneshot scrape job used by the timer

## Debian Setup

1. Install Node.js 20+.
2. Create a dedicated Linux user for the app, for example `mainttracker`.
3. Copy this project into that user's home directory.
4. Install dependencies:

```bash
npm install
npx playwright install chromium
sudo apt-get install -y xvfb
```

5. Create your environment file:

```bash
cp .env.example .env
chmod 600 .env
```

6. Edit `.env` and set:
   - `MOCK_MODE=false` for live scraping
   - `FBO_VENDOR=myfbo`
   - `FBO_LOGIN_URL`
   - `FBO_MAINTENANCE_URL`
   - `FBO_USERNAME`
   - `FBO_PASSWORD`
   - optional `MYFBO_AIRPORT` if the maintenance report must be filtered to a specific airport before opening
   - optional `MYFBO_BASE_FILTER` if you want to keep only aircraft based at one location such as `KORL`
   - `PLAYWRIGHT_HEADLESS=false` if MyFBO will not work in headless mode
   - optional `MYFBO_ORG_ID` if you use the generic MyFBO subscriber login page
   - optional `MYFBO_REPORT_TYPE=summary` or `detailed` with `detailed` recommended for squawks, annuals, and other maintenance items
   - optional `DASHBOARD_BASIC_AUTH_USER` and `DASHBOARD_BASIC_AUTH_PASS`

## Running Manually

Run one scrape:

```bash
npm run scrape
```

Start the local dashboard server:

```bash
npm run server
```

By default the server binds to `127.0.0.1:3100`, which is safer for reverse-proxy setups.

If your FBO blocks headless browsers, run under a virtual display:

```bash
xvfb-run -a --server-args="-screen 0 1440x1200x24" npm run scrape
xvfb-run -a --server-args="-screen 0 1440x1200x24" npm run server
```

## Mock Mode

Set `MOCK_MODE=true` in `.env` to populate the dashboard with sample aircraft data. This is the easiest way to verify the UI, embedding, and systemd wiring before you add real selectors.

## Scraper Customization

Because your FBO site structure is not available yet, `src/scraper.js` uses placeholder selectors:

- `SELECTORS.username`
- `SELECTORS.password`
- `SELECTORS.submit`
- `SELECTORS.maintenanceNav`
- `SELECTORS.maintenanceTable`
- `SELECTORS.maintenanceRows`

Update those selectors after inspecting your site in a browser. The key places to edit are:

- `loginToFbo(page)`
- `navigateToMaintenance(page)`
- `extractAircraftData(page)`

The row parser currently assumes a table-based layout with these columns:

1. Tail number
2. Current time
3. Last 100-hour
4. Next 100-hour due
5. Hours remaining
6. Warning columns after that

If your site uses cards, nested panels, or labels instead of a table, replace `extractAircraftData()` with the right DOM traversal logic.

## MyFBO Notes

The scraper now includes a MyFBO-specific flow based on MyFBO help documentation:

- Login page or subscriber login page
- `Manage`
- `Maintenance`
- Maintenance status report for all aircraft
- `Summary` or `Detailed` report mode

If your school logs in through a school-branded page instead of the generic MyFBO login screen:

- set `FBO_LOGIN_URL` to that school page
- leave `MYFBO_ORG_ID` blank unless you need the fallback MyFBO identifier step

If your school uses the generic MyFBO subscriber login page:

- set `FBO_LOGIN_URL=https://www.myfbo.com/myfbo/login.htm`
- set `MYFBO_ORG_ID` to your four-letter subscriber identifier

If your school uses a MyFBO entry URL like `https://myfbo.com/entry/entry.asp?fbo=xxxx`:

- set `FBO_LOGIN_URL` to that exact entry URL
- set `FBO_USERNAME` to the email field used on that screen
- set `MYFBO_AIRPORT` if your recorded flow chooses an airport in `select[name="apt"]`
- set `MYFBO_BASE_FILTER=KORL` if you only want aircraft based at `KORL`
- the scraper now follows the recorded frame flow: `Online System` -> `Manage` -> `Resource Mgmt` -> `Maintenance` -> airport select -> `Summary` or `Detailed`

For the richest data set, use `MYFBO_REPORT_TYPE=detailed`. That mode allows the parser to capture:

- aircraft base
- 100-hour inspection due values
- annual inspection due values
- other calendar and tach-based maintenance items
- scheduled maintenance blocks
- unresolved squawks

The current extractor is designed to get you close, not to be perfect without a live sample page. Once you can log in, the most likely final adjustment will be inside `extractAircraftData()` to match the exact table headers and row layout shown by your MyFBO account.

## Running MyFBO Without A Physical Monitor

If MyFBO refuses true headless mode, the usual Debian fix is:

- set `PLAYWRIGHT_HEADLESS=false`
- run Playwright inside `Xvfb`
- keep your server itself bound to `127.0.0.1`

This gives Chromium a real X display even though no monitor is attached. The included `systemd` service files now use `xvfb-run` for both the dashboard service and the scheduled scrape job so you do not have to keep a physical display connected.

## API

### `GET /api/maintenance`

Returns the latest stored state:

```json
{
  "status": "ok",
  "source": "live",
  "lastAttemptedUpdate": "2026-06-05T13:00:00.000Z",
  "lastSuccessfulUpdate": "2026-06-05T13:00:00.000Z",
  "runDurationMs": 2143,
  "error": null,
  "data": [],
  "analysis": {}
}
```

### `POST /api/maintenance/refresh`

Triggers a manual refresh. Protect this behind localhost or reverse-proxy auth.

## Dashboard Embedding

Embed it in your existing website with an iframe like:

```html
<iframe
  src="http://127.0.0.1:3100/dashboard"
  title="Aircraft maintenance dashboard"
  style="width:100%;min-height:900px;border:0;"
></iframe>
```

In production you will usually expose it through Nginx, Caddy, or Apache with TLS and, if needed, additional auth controls.

## Refresh Scheduling

The included timer runs the scraper every 3 hours. Adjust the timer if you want 1-hour or 2-hour refreshes instead.

## Security Notes

- Credentials stay server-side in environment variables only.
- Passwords are never written to the frontend.
- If your FBO supports it, the scraper can run headless.
- If your FBO rejects headless mode, run it in headed mode inside `Xvfb` so no physical display is required.
- The dashboard binds to localhost by default.
- Optional basic auth protects both `/dashboard` and `/api`.
- On scrape failure, the app keeps the last known good aircraft data and records the error separately.

## Logs and Data

- State file: `data/maintenance-state.json`
- Logs: `data/logs/YYYY-MM-DD.log`

## systemd

Copy the example files from `systemd/` into `/etc/systemd/system/`, update the paths, then enable them:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now maintenance-tracker.service
sudo systemctl enable --now maintenance-tracker.timer
```

The service hosts the dashboard. The timer runs the scraper on a schedule.

Before enabling those services on Debian, make sure `/usr/bin/xvfb-run` exists. On most Debian systems it is provided by the `xvfb` package.
