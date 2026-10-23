import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rfp-runner-"));
const tasksFile = path.join(tmp, "tasks.json");
fs.writeFileSync(tasksFile, JSON.stringify({ tasks: [{
  id: "guest-rfp-creation",
  command: [process.execPath, path.join(here, "fixtures", "stub.mjs"), "--venue", "{{venue_name}}"],
  env: { SLACK_CHANNEL_ID: "{{slack_channel_id}}", RFP_REQUESTED_BY: "{{requested_by}}" },
  maxConcurrent: 1,
  resultMarker: true,
  params: [{ key: "venue_name", required: true }, { key: "slack_channel_id" }, { key: "requested_by" }],
}] }));
Object.assign(process.env, { TASKS_CONFIG: tasksFile, DATA_DIR: path.join(tmp, "data"), AUTH_DISABLED: "true", MAX_CONCURRENT_JOBS: "2" });

const { loadTasks, getTask } = await import("../src/tasks.js");
const { createJob, getJob, readLog } = await import("../src/jobs.js");
const { enqueue } = await import("../src/runner.js");
loadTasks();

const TERMINAL = ["succeeded", "failed", "canceled", "timeout"];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function start(venue, extra = {}) {
  const job = createJob({ taskId: "guest-rfp-creation", params: { venue_name: venue, ...extra } });
  enqueue(job);
  return job;
}
async function finished(job) {
  for (let i = 0; i < 150 && !TERMINAL.includes(getJob(job.id).status); i++) await sleep(100);
  return getJob(job.id);
}

test("a RESULT: SUBMITTED line marks the job succeeded", async () => {
  const job = await finished(start("Test OK"));
  assert.equal(job.status, "succeeded");
  assert.equal(job.result, "SUBMITTED");
});

test("cancelled and failed results mark the job failed, even when the exit code differs", async () => {
  const cancelled = await finished(start("Test Cancel"));
  assert.equal(cancelled.status, "failed");
  assert.equal(cancelled.result, "CANCELLED");
  assert.equal(cancelled.exitCode, 2);
  const failed = await finished(start("Test Fail"));
  assert.equal(failed.status, "failed");
  assert.equal(failed.result, "FAILED");
});

test("a run that dies without a RESULT line is a failure that says so", async () => {
  const job = await finished(start("Test Crash"));
  assert.equal(job.status, "failed");
  assert.equal(job.result ?? null, null);
  assert.match(job.error, /without a RESULT line/);
});

test("params reach the program as env vars, and files stay in the job's own folder", async () => {
  const job = await finished(start("Test OK", { slack_channel_id: "C0TEST12345", requested_by: "U0ABC12345" }));
  assert.match(readLog(job.id), /channel=C0TEST12345 by=U0ABC12345 cwd=jobs\//);
  assert.ok(fs.existsSync(path.join(tmp, "data", "jobs", job.id, "step1.png")));
});

test("maxConcurrent: a second job of the same task waits for the first", async () => {
  const first = start("Test Slow One");
  const second = start("Test Slow Two");
  await sleep(300);
  assert.equal(getJob(first.id).status, "running");
  assert.equal(getJob(second.id).status, "queued");
  assert.equal((await finished(first)).status, "succeeded");
  assert.equal((await finished(second)).status, "succeeded");
});

test("tasks.json entries need a command", () => {
  assert.equal(getTask("guest-rfp-creation").command[0], process.execPath);
});
