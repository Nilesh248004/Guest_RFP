import express from "express";
import config from "./config.js";
import { apiKeyAuth } from "./auth.js";
import { loadTasks } from "./tasks.js";
import { rehydrate } from "./jobs.js";
import { runnerStats } from "./runner.js";
import { startSlackBot } from "./slack-bot.js";
import tasksRouter from "./routes/tasks.js";
import jobsRouter from "./routes/jobs.js";

const app = express();
app.use(express.json({ limit: "256kb" }));

// Health check is public (no auth) for load balancers / uptime checks.
app.get("/health", (req, res) => {
  res.json({ status: "ok", runner: runnerStats() });
});

// Everything below requires a valid API key (unless AUTH_DISABLED=true).
app.use(apiKeyAuth);

app.use("/tasks", tasksRouter);
app.use("/jobs", jobsRouter);

app.use((req, res) => res.status(404).json({ error: "Not found" }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error("[error]", err);
  res.status(err.status || 500).json({ error: err.message || "Internal error" });
});

function bootstrap() {
  const count = loadTasks();
  rehydrate();
  app.listen(config.port, config.host, () => {
    console.log(`goose-rfp-bot listening on http://${config.host}:${config.port}`);
    console.log(`Loaded ${count} task(s). Auth ${config.authDisabled ? "DISABLED" : "enabled"}.`);
    if (config.slackBot.enabled) {
      startSlackBot().catch((err) => console.error("[slack-bot] failed to start:", err.message));
    }
  });
}

bootstrap();
