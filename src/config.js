import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

// Minimal .env loader (avoids an extra dependency). Does not override existing env vars.
function loadDotEnv() {
  const envPath = path.join(projectRoot, ".env");
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, "utf8").split("\n");
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadDotEnv();

function resolveFromRoot(p) {
  if (!p) return p;
  return path.isAbsolute(p) ? p : path.resolve(projectRoot, p);
}

const config = {
  projectRoot,
  port: parseInt(process.env.PORT || "8787", 10),
  host: process.env.HOST || "127.0.0.1",
  apiKeys: (process.env.API_KEYS || "")
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean),
  authDisabled: String(process.env.AUTH_DISABLED || "false").toLowerCase() === "true",
  tasksConfig: resolveFromRoot(process.env.TASKS_CONFIG || "./config/tasks.json"),
  dataDir: resolveFromRoot(process.env.DATA_DIR || "./data"),
  maxConcurrentJobs: Math.max(1, parseInt(process.env.MAX_CONCURRENT_JOBS || "1", 10)),
  jobTimeoutMs: parseInt(process.env.JOB_TIMEOUT_MS || "1800000", 10),
  // /rfpbot in Slack: create a Guest RFP for a hotel from config/rfp-hotels.json, or add a hotel (src/slack-bot.js).
  slackBot: {
    enabled: String(process.env.SLACK_BOT_ENABLED || "false").toLowerCase() === "true",
    botToken: process.env.SLACK_BOT_TOKEN || "",
    appToken: process.env.SLACK_APP_TOKEN || "",
    channel: process.env.SLACK_CHANNEL_ID || "",
    users: (process.env.SLACK_ALLOWED_USERS || "")
      .split(",")
      .map((u) => u.trim())
      .filter(Boolean),
    hotelsFile: resolveFromRoot(process.env.RFP_HOTELS_CONFIG || "./config/rfp-hotels.json"),
  },
};

if (!config.authDisabled && config.apiKeys.length === 0) {
  console.error(
    "[config] No API_KEYS set and AUTH_DISABLED is not true. Refusing to start an unsecured server."
  );
  process.exit(1);
}

fs.mkdirSync(config.dataDir, { recursive: true });

export default config;
