// Stand-in for rfp.py: behaves according to the venue name so the server can be tested without Cvent.
import fs from "node:fs";
const venue = process.argv[process.argv.indexOf("--venue") + 1] || "";
fs.writeFileSync("step1.png", "x"); // like a screenshot: must land in the job's own folder
console.log(`channel=${process.env.SLACK_CHANNEL_ID} by=${process.env.RFP_REQUESTED_BY} cwd=${process.cwd().split("/").slice(-2).join("/")}`);
const done = (line, code) => { if (line) console.log(line); process.exit(code); };
if (venue.includes("Cancel")) done("RESULT: CANCELLED", 2);
if (venue.includes("Fail")) done("RESULT: FAILED", 1);
if (venue.includes("Crash")) done(null, 1);
setTimeout(() => done("RESULT: SUBMITTED", 0), venue.includes("Slow") ? 1500 : 50);
