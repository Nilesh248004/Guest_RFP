import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import config from "./config.js";
import { maskParams, maskSecrets } from "./secrets.js";
export { isSecretKey, maskParams, maskSecrets } from "./secrets.js";

// In-memory index of jobs. Logs and metadata are also persisted to disk so the
// API can serve results for jobs even after restart (metadata) and stream logs.
const jobs = new Map();

function jobDir(id) {
  return path.join(config.dataDir, "jobs", id);
}

function metaPath(id) {
  return path.join(jobDir(id), "meta.json");
}

export function logPath(id) {
  return path.join(jobDir(id), "output.log");
}

export function createJob({ taskId, params }) {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const job = {
    id,
    taskId,
    params,
    status: "queued", // queued | running | succeeded | failed | canceled | timeout
    exitCode: null,
    createdAt: now,
    startedAt: null,
    finishedAt: null,
    error: null,
  };
  fs.mkdirSync(jobDir(id), { recursive: true });
  fs.writeFileSync(logPath(id), "");
  jobs.set(id, job);
  persist(job);
  return job;
}

export function persist(job) {
  // The in-memory job keeps the real params for the runner; only a masked copy
  // goes to disk (jobs are never re-run from disk after a restart).
  fs.writeFileSync(metaPath(job.id), JSON.stringify({
    ...job,
    params: maskParams(job.params),
    error: job.error == null ? job.error : maskSecrets(job.error, job.params),
  }, null, 2));
}

export function getJob(id) {
  if (jobs.has(id)) return jobs.get(id);
  // Fall back to disk (e.g. after restart).
  const mp = metaPath(id);
  if (fs.existsSync(mp)) {
    try {
      const job = JSON.parse(fs.readFileSync(mp, "utf8"));
      jobs.set(id, job);
      return job;
    } catch {
      return null;
    }
  }
  return null;
}

export function listJobs() {
  return [...jobs.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export function readLog(id) {
  const lp = logPath(id);
  return fs.existsSync(lp) ? fs.readFileSync(lp, "utf8") : "";
}

// Public-safe view: secret params are masked.
export function publicView(job) {
  return {
    id: job.id,
    taskId: job.taskId,
    status: job.status,
    exitCode: job.exitCode,
    result: job.result ?? null,
    params: maskParams(job.params),
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    error: job.error == null ? job.error : maskSecrets(job.error, job.params),
  };
}

// Rehydrate the in-memory index from disk on startup. Any job left "running"
// or "queued" from a previous process is marked interrupted.
export function rehydrate() {
  const base = path.join(config.dataDir, "jobs");
  if (!fs.existsSync(base)) return;
  for (const id of fs.readdirSync(base)) {
    const job = getJob(id);
    if (!job) continue;
    if (job.status === "running" || job.status === "queued") {
      job.status = "failed";
      job.error = "Interrupted by server restart";
      job.finishedAt = new Date().toISOString();
      persist(job);
    }
  }
}
