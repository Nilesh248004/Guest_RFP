import fs from "node:fs";
import config from "./config.js";

let tasksById = new Map();

export function loadTasks() {
  if (!fs.existsSync(config.tasksConfig)) {
    throw new Error(`Tasks config not found at ${config.tasksConfig}`);
  }
  const parsed = JSON.parse(fs.readFileSync(config.tasksConfig, "utf8"));
  const list = Array.isArray(parsed.tasks) ? parsed.tasks : [];
  const map = new Map();
  for (const t of list) {
    if (!t.id || !Array.isArray(t.command) || t.command.length === 0) {
      throw new Error(`Task entry needs an "id" and a "command" (argv array): ${JSON.stringify(t)}`);
    }
    if (map.has(t.id)) throw new Error(`Duplicate task id: ${t.id}`);
    map.set(t.id, {
      id: t.id,
      name: t.name || t.id,
      description: t.description || "",
      // The program to run: an argv array. {{param}} is replaced by the job's param and {{root}} by
      // the project folder. "env" adds environment variables (same placeholders).
      command: t.command.map(String),
      env: t.env && typeof t.env === "object" ? t.env : {},
      // timeoutMs replaces JOB_TIMEOUT_MS, maxConcurrent caps how many jobs of this task run at
      // once, resultMarker maps the program's final "RESULT: ..." line to the job status.
      timeoutMs: Number.isFinite(t.timeoutMs) && t.timeoutMs > 0 ? t.timeoutMs : null,
      maxConcurrent: Number.isInteger(t.maxConcurrent) && t.maxConcurrent > 0 ? t.maxConcurrent : null,
      resultMarker: t.resultMarker === true,
      params: Array.isArray(t.params) ? t.params : [],
    });
  }
  tasksById = map;
  return list.length;
}

export function listTasks() {
  return [...tasksById.values()];
}

export function getTask(id) {
  return tasksById.get(id) || null;
}

/**
 * Validate caller-supplied params against the task's declared param schema.
 * Only declared keys are accepted (allowlist). Returns { ok, errors, params }.
 */
export function validateParams(task, input) {
  const errors = [];
  const out = {};
  const provided = input && typeof input === "object" ? input : {};
  const allowedKeys = new Set(task.params.map((p) => p.key));

  for (const key of Object.keys(provided)) {
    if (!allowedKeys.has(key)) errors.push(`Unknown parameter: "${key}"`);
  }

  for (const p of task.params) {
    const value = provided[p.key];
    const present = value !== undefined && value !== null && value !== "";
    if (!present) {
      if (p.required) errors.push(`Missing required parameter: "${p.key}"`);
      continue;
    }
    const str = String(value);
    if (/[\r\n\0]/.test(str)) {
      errors.push(`Parameter "${p.key}" contains illegal characters`);
      continue;
    }
    if (p.pattern && !new RegExp(p.pattern).test(str)) {
      errors.push(`Parameter "${p.key}" does not match required format`);
      continue;
    }
    out[p.key] = str;
  }

  return { ok: errors.length === 0, errors, params: out };
}
