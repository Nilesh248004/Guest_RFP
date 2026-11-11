import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rfp-bot-"));
const tasksFile = path.join(tmp, "tasks.json");
// Same params as config/tasks.json, but it runs the stand-in program instead of Cvent.
const real = JSON.parse(fs.readFileSync(path.join(here, "..", "config", "tasks.json"), "utf8")).tasks[0];
fs.writeFileSync(tasksFile, JSON.stringify({ tasks: [{ ...real, command: [process.execPath, path.join(here, "fixtures", "stub.mjs"), "--venue", "{{venue_name}}"] }] }));
const hotelsFile = path.join(tmp, "hotels.json"); // does not exist yet: first use must copy the bundled list
Object.assign(process.env, {
  TASKS_CONFIG: tasksFile, DATA_DIR: path.join(tmp, "data"), AUTH_DISABLED: "true", RFP_HOTELS_CONFIG: hotelsFile,
  SLACK_BOT_TOKEN: "xoxb-test", SLACK_APP_TOKEN: "xapp-test", SLACK_CHANNEL_ID: "C0CBF5XRJKD", SLACK_ALLOWED_USERS: "U111AAAA,U222BBBB",
});

const bot = await import("../src/slack-bot.js");
const { loadTasks } = await import("../src/tasks.js");
const { listJobs } = await import("../src/jobs.js");
loadTasks();

const calls = [];
bot.setApiForTests(async (method, body) => { calls.push({ method, body }); return { ok: true }; });
const mkAck = () => { const f = async (p) => { f.payload = p; f.called = (f.called || 0) + 1; }; return f; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bundled = JSON.parse(fs.readFileSync(path.join(here, "..", "config", "rfp-hotels.json"), "utf8")).hotels.length;

test("the first load starts the list as a copy of the bundled hotels", () => {
  assert.ok(!fs.existsSync(hotelsFile));
  assert.equal(bot.loadHotels().length, bundled);
  assert.ok(fs.existsSync(hotelsFile));
});

test("/rfpbot opens a form whose first dropdown redraws it", async () => {
  const ack = mkAck();
  await bot.onSlash({ ack, body: { user_id: "U111AAAA", trigger_id: "t1" } });
  const view = calls.find((c) => c.method === "views.open").body.view;
  assert.equal(ack.called, 1);
  assert.equal(view.blocks[0].dispatch_action, true);
  assert.deepEqual(view.blocks[0].element.options.map((o) => o.text.text), ["Create Guest RFP", "Add hotel"]);
  assert.equal(view.blocks[1].element.type, "multi_external_select");
});

test("choosing Add hotel shows a name box, choosing Create shows the hotel list", async () => {
  calls.length = 0;
  const pick = (value) => bot.onInteractive({ ack: mkAck(), body: { type: "block_actions", user: { id: "U111AAAA" }, view: { id: "V1" }, actions: [{ action_id: "action", selected_option: { value } }] } });
  await pick("add");
  assert.equal(calls[0].method, "views.update");
  assert.equal(calls[0].body.view.blocks[1].element.type, "plain_text_input");
  await pick("create");
  assert.equal(calls[1].body.view.blocks[1].element.type, "multi_external_select");
});

test("typing in the hotel select filters the list", async () => {
  const ack = mkAck();
  await bot.onInteractive({ ack, body: { type: "block_suggestion", action_id: "hotel", value: "dallas" } });
  assert.ok(ack.payload.options.length >= 1);
  assert.ok(ack.payload.options.every((o) => /dallas/i.test(o.text.text)));
});

const addBody = (value, user = "U111AAAA") => ({ type: "view_submission", user: { id: user }, view: { callback_id: "rfp_add", state: { values: { hotel_name: { hotel_name: { value } } } } } });

test("Add hotel: a new name is tidied, saved and offered in the list", async () => {
  const ack = mkAck();
  await bot.onInteractive({ ack, body: addBody("  Hyatt Regency   Dallas ") });
  assert.equal(ack.payload, undefined); // form closes
  const hotels = bot.loadHotels();
  assert.equal(hotels.at(-1).name, "Hyatt Regency Dallas");
  assert.equal(hotels.length, bundled + 1);
  assert.equal(bot.hotelOptions(hotels, "hyatt").length, 1);
  assert.ok(calls.some((c) => c.method === "chat.postEphemeral" && /Hyatt Regency Dallas/.test(c.body.text)));
  assert.ok(!calls.some((c) => c.method === "chat.postMessage")); // nothing public
});

test("Add hotel: duplicates, odd characters, empty names and strangers are rejected inline", async () => {
  for (const [body, pattern] of [
    [addBody("hyatt regency dallas"), /Already in the list/],
    [addBody("Bad <name> $(rm -rf)"), /exactly as shown on Cvent/],
    [addBody("   "), /./],
    [addBody("Some Hotel", "U999NOPE"), /not allowed/],
  ]) {
    const ack = mkAck();
    await bot.onInteractive({ ack, body });
    assert.equal(ack.payload.response_action, "errors");
    assert.match(ack.payload.errors.hotel_name, pattern);
  }
  assert.equal(bot.loadHotels().length, bundled + 1);
});

const createBody = (id, user = "U111AAAA") => ({ type: "view_submission", user: { id: user }, view: { callback_id: "rfp_create", state: { values: { hotel: { hotel: id ? { selected_option: { value: id } } : {} } } } } });

test("Create: no hotel picked starts nothing; a picked hotel starts one run, privately acknowledged", async () => {
  let ack = mkAck();
  await bot.onInteractive({ ack, body: createBody(null) });
  assert.equal(ack.payload.response_action, "errors");
  assert.equal(listJobs().length, 0);

  calls.length = 0;
  ack = mkAck();
  await bot.onInteractive({ ack, body: createBody("hyatt-regency-dallas") });
  await sleep(200);
  const jobs = listJobs();
  assert.equal(jobs.length, 1);
  assert.deepEqual({ venue: jobs[0].params.venue_name, by: jobs[0].params.requested_by, ch: jobs[0].params.slack_channel_id },
    { venue: "Hyatt Regency Dallas", by: "U111AAAA", ch: "C0CBF5XRJKD" });
  assert.ok(calls.some((c) => c.method === "chat.postEphemeral" && c.body.user === "U111AAAA"));
  assert.ok(!calls.some((c) => c.method === "chat.postMessage"));
});

test("Create: the same hotel while it is active is not started twice; other users are refused", async () => {
  assert.ok(bot.addHotel("Slow Test Hotel").ok); // the stand-in program takes 1.5 s for "Slow" names
  const before = listJobs().length;
  await bot.onInteractive({ ack: mkAck(), body: createBody("slow-test-hotel") });
  await sleep(100);
  assert.equal(listJobs().length, before + 1);
  calls.length = 0;
  await bot.onInteractive({ ack: mkAck(), body: createBody("slow-test-hotel", "U222BBBB") });
  await sleep(100);
  assert.equal(listJobs().length, before + 1); // still one
  assert.ok(calls.some((c) => c.method === "chat.postEphemeral" && /already/.test(c.body.text)));
  const ack = mkAck();
  await bot.onInteractive({ ack, body: createBody("slow-test-hotel", "U999NOPE") });
  assert.equal(ack.payload.response_action, "errors");
  await sleep(1800); // let the slow run finish
});

test("a run that ends without any result is reported in the channel", async () => {
  // the stand-in program for "Crash" exits without a RESULT line
  await bot.startRfp("U111AAAA", { id: "crash", name: "Crash Hotel", venue: "Crash Hotel" });
  await sleep(1500);
  calls.length = 0;
  await bot.checkJobs();
  const post = calls.find((c) => c.method === "chat.postMessage");
  assert.ok(post && /stopped without reporting a result/.test(post.body.text) && /Crash Hotel/.test(post.body.text));
});
