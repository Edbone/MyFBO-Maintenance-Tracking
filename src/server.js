require("dotenv").config();

const express = require("express");
const path = require("path");
const { runScrape } = require("./scraper");
const { ensureDataLayout, readState } = require("./storage");

const app = express();
const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT || 3100);

ensureDataLayout();

function basicAuth(req, res, next) {
  const expectedUser = process.env.DASHBOARD_BASIC_AUTH_USER;
  const expectedPass = process.env.DASHBOARD_BASIC_AUTH_PASS;

  if (!expectedUser || !expectedPass) {
    return next();
  }

  const header = req.headers.authorization || "";
  const [scheme, encoded] = header.split(" ");

  if (scheme !== "Basic" || !encoded) {
    res.set("WWW-Authenticate", 'Basic realm="Maintenance Dashboard"');
    return res.status(401).send("Authentication required");
  }

  const [username, password] = Buffer.from(encoded, "base64").toString("utf8").split(":");
  if (username !== expectedUser || password !== expectedPass) {
    res.set("WWW-Authenticate", 'Basic realm="Maintenance Dashboard"');
    return res.status(401).send("Invalid credentials");
  }

  return next();
}

app.use("/dashboard", basicAuth);
app.use("/api", basicAuth);
app.use("/static", express.static(path.join(process.cwd(), "public")));

app.get("/api/maintenance", (_req, res) => {
  const state = readState();
  res.json(state);
});

app.post("/api/maintenance/refresh", basicAuth, async (_req, res) => {
  try {
    const state = await runScrape();
    res.json(state);
  } catch (error) {
    res.status(500).json({
      status: "error",
      error: error.message,
      state: readState()
    });
  }
});

app.get("/dashboard", (_req, res) => {
  res.sendFile(path.join(process.cwd(), "public", "dashboard.html"));
});

app.get("/", (_req, res) => {
  res.redirect("/dashboard");
});

async function hydrateInitialState() {
  const state = readState();
  if (state.lastSuccessfulUpdate) {
    return;
  }

  try {
    await runScrape();
  } catch (error) {
    console.error(`Initial maintenance refresh failed: ${error.message}`);
  }
}

app.listen(port, host, () => {
  console.log(`Maintenance dashboard listening on http://${host}:${port}/dashboard`);
});

hydrateInitialState();
