import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import config from "./config.js";
import { persist, logPath, maskSecrets } from "./jobs.js";
import { getTask } from "./tasks.js";

// Simple concurrency-limited queue.
const queue = [];
const running = new Map(); // jobId -> child process
const runningTasks = new Map(); // jobId -> taskId (for per-task maxConcurrent)

// A task with resultMarker ends its output with "RESULT: SUBMITTED|CANCELLED|FAILED".
const RESULT_LINE = /^RESULT: (SUBMITTED|CANCELLED|FAILED)\s*$/;

// A task may cap how many of its jobs run at once (tasks.json "maxConcurrent").
function canStart(job) {
  const cap = getTask(job.taskId)?.maxConcurrent;
  if (!cap) return true;
  let n = 0;
  for (const taskId of runningTasks.values()) if (taskId === job.taskId) n++;
  return n < cap;
}

const fill = (text, params) =>
  String(text).replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key) => (params?.[key] ?? "").toString());

// What to run for a job: the task's command, inside the job's own folder so screenshots and files
// stay with the job. Spawned without a shell, so param values cannot inject commands.
function spawnSpec(job, task) {
  const values = { ...job.params, root: config.projectRoot };
  const [cmd, ...args] = task.command.map((a) => fill(a, values));
  const env = { ...process.env };
  for (const [key, value] of Object.entries(task.env || {})) env[key] = fill(value, values);
  return { cmd, args, env, cwd: path.dirname(logPath(job.id)) };
}

function pump() {
  while (running.size < config.maxConcurrentJobs) {
    const i = queue.findIndex(canStart);
    if (i === -1) break;
    start(queue.splice(i, 1)[0]);
  }
}

function start(job) {
  const task = getTask(job.taskId);
  const { cmd, args, env, cwd } = spawnSpec(job, task);
  job.status = "running";
  job.startedAt = new Date().toISOString();
  persist(job);

  const logStream = fs.createWriteStream(logPath(job.id), { flags: "a" });
  logStream.write(maskSecrets(`$ ${cmd} ${args.join(" ")}\n\n`, job.params));

  // Output is masked line by line, so a secret split across two chunks is still caught.
  const pending = { stdout: "", stderr: "" };
  const trackResult = (line) => {
    if (!task?.resultMarker) return;
    const m = RESULT_LINE.exec(line.trim());
    if (m) job.result = m[1];
  };
  const writeMasked = (stream, data) => {
    const lines = (pending[stream] + data.toString()).split("\n");
    pending[stream] = lines.pop();
    for (const line of lines) {
      trackResult(line);
      logStream.write(maskSecrets(line, job.params) + "\n");
    }
  };
  const flushMasked = () => {
    for (const stream of Object.keys(pending)) {
      if (pending[stream]) {
        trackResult(pending[stream]);
        logStream.write(maskSecrets(pending[stream], job.params));
      }
      pending[stream] = "";
    }
  };

  let child;
  try {
    child = spawn(cmd, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    job.status = "failed";
    job.error = `Failed to start ${path.basename(cmd)}: ${err.message}`;
    job.finishedAt = new Date().toISOString();
    persist(job);
    logStream.end();
    pump();
    return;
  }

  running.set(job.id, child);
  runningTasks.set(job.id, job.taskId);

  child.stdout.on("data", (d) => writeMasked("stdout", d));
  child.stderr.on("data", (d) => writeMasked("stderr", d));

  let timedOut = false;
  let timer = null;
  const timeoutMs = task?.timeoutMs ?? config.jobTimeoutMs;
  if (timeoutMs > 0) {
    timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5000).unref();
    }, timeoutMs);
  }

  const finalize = (status, exitCode, errMsg) => {
    if (timer) clearTimeout(timer);
    flushMasked();
    running.delete(job.id);
    runningTasks.delete(job.id);
    job.status = status;
    job.exitCode = exitCode;
    if (errMsg) job.error = errMsg;
    job.finishedAt = new Date().toISOString();
    persist(job);
    logStream.end();
    pump();
  };

  child.on("error", (err) => {
    logStream.write(`\n[runner] process error: ${err.message}\n`);
    finalize("failed", null, err.message);
  });

  child.on("close", (code, signal) => {
    if (job.status === "canceled") {
      finalize("canceled", code, job.error);
      return;
    }
    if (timedOut) {
      logStream.write(`\n[runner] job timed out after ${timeoutMs}ms\n`);
      finalize("timeout", code, "Job exceeded timeout");
      return;
    }
    if (task?.resultMarker) {
      if (job.result === "SUBMITTED") finalize("succeeded", 0, null);
      else if (job.result) finalize("failed", code, `Task result: ${job.result}`);
      else if (code === 0) finalize("failed", 0, "Task finished without a RESULT line");
      else finalize("failed", code, `Task exited with code ${code}${signal ? ` (signal ${signal})` : ""} without a RESULT line`);
    } else if (code === 0) {
      finalize("succeeded", 0, null);
    } else {
      finalize("failed", code, `Process exited with code ${code}${signal ? ` (signal ${signal})` : ""}`);
    }
  });
}

export function enqueue(job) {
  queue.push(job);
  pump();
}

export function cancel(job) {
  // Remove from queue if not yet started.
  const qi = queue.findIndex((j) => j.id === job.id);
  if (qi !== -1) {
    queue.splice(qi, 1);
    job.status = "canceled";
    job.error = "Canceled before start";
    job.finishedAt = new Date().toISOString();
    persist(job);
    return true;
  }
  const child = running.get(job.id);
  if (child) {
    job.status = "canceled";
    job.error = "Canceled by request";
    persist(job);
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), 5000).unref();
    return true;
  }
  return false;
}

export function runnerStats() {
  return { running: running.size, queued: queue.length, maxConcurrent: config.maxConcurrentJobs };
}
