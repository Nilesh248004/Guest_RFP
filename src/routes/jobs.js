import { Router } from "express";
import { listJobs, getJob, publicView, readLog } from "../jobs.js";
import { cancel } from "../runner.js";

const router = Router();

router.get("/", (req, res) => {
  res.json({ jobs: listJobs().map(publicView) });
});

router.get("/:id", (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: "Unknown job" });
  res.json({ job: publicView(job) });
});

// Full captured stdout/stderr for a job.
router.get("/:id/logs", (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: "Unknown job" });
  res.type("text/plain").send(readLog(job.id));
});

router.post("/:id/cancel", (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: "Unknown job" });
  if (["succeeded", "failed", "canceled", "timeout"].includes(job.status)) {
    return res.status(409).json({ error: `Job already ${job.status}` });
  }
  const ok = cancel(job);
  res.json({ canceled: ok, job: publicView(job) });
});

export default router;
