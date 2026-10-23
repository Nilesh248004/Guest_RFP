import { Router } from "express";
import { listTasks, getTask, validateParams } from "../tasks.js";
import { createJob, publicView } from "../jobs.js";
import { enqueue } from "../runner.js";

const router = Router();

// List the allowlisted tasks and their declared params.
router.get("/", (req, res) => {
  res.json({ tasks: listTasks() });
});

router.get("/:id", (req, res) => {
  const task = getTask(req.params.id);
  if (!task) return res.status(404).json({ error: "Unknown task" });
  res.json(task);
});

// Start a task. Body: { params: { ... } }
router.post("/:id/run", (req, res) => {
  const task = getTask(req.params.id);
  if (!task) return res.status(404).json({ error: "Unknown task" });

  const { ok, errors, params } = validateParams(task, req.body?.params);
  if (!ok) return res.status(400).json({ error: "Invalid parameters", details: errors });

  const job = createJob({ taskId: task.id, params });
  enqueue(job);

  res.status(202).json({
    job: publicView(job),
    links: {
      self: `/jobs/${job.id}`,
      logs: `/jobs/${job.id}/logs`,
    },
  });
});

export default router;
