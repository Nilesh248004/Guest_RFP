import fs from "node:fs";
import path from "node:path";
import { SocketModeClient } from "@slack/socket-mode";
import config from "./config.js";
import { getTask, validateParams } from "./tasks.js";
import { createJob, getJob, listJobs } from "./jobs.js";
import { enqueue } from "./runner.js";

// The /rfpbot Slack command opens a form with a first dropdown:
//   Create Guest RFP -> a searchable list of the configured hotels; Create starts guest-rfp-creation
//   Add hotel        -> a box for the exact hotel name as shown on Cvent; it is added to the list
// It connects to Slack over Socket Mode, so no public URL is needed (SLACK_APP_TOKEN, xapp-...).
// The RFP script itself posts the result to the channel with the bot token.

const TASK_ID = "guest-rfp-creation";
const CALLBACK_CREATE = "rfp_create";
const CALLBACK_ADD = "rfp_add";
const MODE_LABELS = { create: "Create Guest RFP", add: "Add hotel" };
const SEED_FILE = path.join(config.projectRoot, "config", "rfp-hotels.json");
const TERMINAL = new Set(["succeeded", "failed", "canceled", "timeout"]);
const cfg = config.slackBot;
const tracked = new Map(); // jobId -> { user, hotel } for jobs started from the form

const log = (...args) => console.log("[slack-bot]", ...args);

// Slack Web API call with the bot token. Replaceable in tests.
let api = async (method, body) => {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${cfg.botToken}`, "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`${method}: ${data.error}`);
  return data;
};
export function setApiForTests(fn) {
  api = fn;
}

// ---- hotels -------------------------------------------------------------------------------

const slug = (s) =>
  String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

// The list lives in cfg.hotelsFile. When that is a different file (for example on a mounted volume)
// and does not exist yet, it starts as a copy of the bundled config/rfp-hotels.json.
function ensureHotelsFile(file) {
  if (fs.existsSync(file) || !fs.existsSync(SEED_FILE)) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.copyFileSync(SEED_FILE, file);
}

/** Reads the hotel list fresh each time, so editing the file needs no restart. */
export function loadHotels(file = cfg.hotelsFile) {
  ensureHotelsFile(file);
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  const list = Array.isArray(raw) ? raw : raw.hotels;
  const hotels = [];
  const seen = new Set();
  for (const h of Array.isArray(list) ? list : []) {
    const venue = String(h?.venue_name || h?.name || "").trim();
    const name = String(h?.name || venue).trim();
    const id = slug(h?.id || name).slice(0, 100);
    if (!venue || !id || seen.has(id)) continue;
    seen.add(id);
    hotels.push({ id, name, venue });
  }
  return hotels;
}

/**
 * Adds a hotel (the exact name as shown on Cvent) to the list file.
 * Returns { ok: true, hotel } or { ok: false, error } with a message for the person.
 */
export function addHotel(rawName, file = cfg.hotelsFile) {
  const name = String(rawName || "").replace(/\s+/g, " ").trim();
  const task = getTask(TASK_ID);
  if (task && !validateParams(task, { venue_name: name }).ok) {
    return { ok: false, error: "Use the name exactly as shown on Cvent: 2 to 150 characters, letters, numbers, spaces and . , ' & ( ) / : -" };
  }
  const existing = loadHotels(file);
  const same = existing.find((h) => h.id === slug(name) || h.venue.toLowerCase() === name.toLowerCase());
  if (same) return { ok: false, error: `Already in the list as "${same.name}".` };

  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  const doc = Array.isArray(raw) ? { hotels: raw } : raw;
  doc.hotels = [...(Array.isArray(doc.hotels) ? doc.hotels : []), { name }];
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2) + "\n");
  fs.renameSync(tmp, file);
  return { ok: true, hotel: { id: slug(name).slice(0, 100), name, venue: name } };
}

export function hotelOptions(hotels, query = "") {
  const q = String(query || "").trim().toLowerCase();
  return hotels
    .filter((h) => !q || h.name.toLowerCase().includes(q))
    .slice(0, 100)
    .map((h) => ({ text: { type: "plain_text", text: h.name.slice(0, 75) }, value: h.id }));
}

export function buildModal(mode = "create") {
  const option = (value) => ({ text: { type: "plain_text", text: MODE_LABELS[value] }, value });
  const isAdd = mode === "add";
  const blocks = [
    {
      type: "input",
      block_id: "action",
      dispatch_action: true, // picking another option redraws the form (see onInteractive)
      label: { type: "plain_text", text: "What do you want to do?" },
      element: {
        type: "static_select",
        action_id: "action",
        options: [option("create"), option("add")],
        initial_option: option(isAdd ? "add" : "create"),
      },
    },
  ];
  if (isAdd) {
    blocks.push(
      {
        type: "input",
        block_id: "hotel_name",
        label: { type: "plain_text", text: "Hotel name" },
        hint: { type: "plain_text", text: "Exactly as it is shown on Cvent. A different spelling will not be found when the RFP runs." },
        element: {
          type: "plain_text_input",
          action_id: "hotel_name",
          max_length: 150,
          placeholder: { type: "plain_text", text: "e.g. Sheraton Suites Market Center Dallas" },
        },
      },
      {
        type: "context",
        elements: [{ type: "mrkdwn", text: "The hotel is added to the list used by *Create Guest RFP*." }],
      }
    );
  } else {
    blocks.push(
      {
        type: "input",
        block_id: "hotel",
        label: { type: "plain_text", text: "Hotel" },
        element: {
          type: "external_select",
          action_id: "hotel",
          min_query_length: 0,
          placeholder: { type: "plain_text", text: "Search or select a hotel" },
        },
      },
      {
        type: "context",
        elements: [
          { type: "mrkdwn", text: `A Guest RFP is created on Cvent for the hotel you pick. The result is posted in <#${cfg.channel}>.` },
        ],
      }
    );
  }
  return {
    type: "modal",
    callback_id: isAdd ? CALLBACK_ADD : CALLBACK_CREATE,
    title: { type: "plain_text", text: isAdd ? "Add hotel" : "Create Guest RFP" },
    submit: { type: "plain_text", text: isAdd ? "Add hotel" : "Create" },
    close: { type: "plain_text", text: "Cancel" },
    blocks,
  };
}

// ---- helpers ------------------------------------------------------------------------------

const allowed = (userId) => cfg.users.length === 0 || cfg.users.includes(userId);

async function tell(userId, text) {
  // Only the requester sees this; the channel itself only gets the result.
  try {
    await api("chat.postEphemeral", { channel: cfg.channel, user: userId, text });
  } catch (err) {
    log("could not send a private message:", err.message);
  }
}

async function respond(url, text) {
  if (!url) return;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ response_type: "ephemeral", text }),
    });
  } catch (err) {
    log("could not answer the command:", err.message);
  }
}

// ---- /rfpbot ------------------------------------------------------------------------------

export async function onSlash({ body, ack }) {
  const user = body.user_id;
  if (!allowed(user)) {
    await ack({ response_type: "ephemeral", text: ":no_entry: You are not allowed to create Guest RFPs." });
    return;
  }
  let hotels;
  try {
    hotels = loadHotels();
  } catch (err) {
    log("cannot read the hotel list:", err.message);
    await ack({ response_type: "ephemeral", text: ":x: The hotel list could not be read. Ask the admin to check the server." });
    return;
  }
  await ack(); // Slack needs this within 3 seconds; the form is opened right after
  try {
    await api("views.open", { trigger_id: body.trigger_id, view: buildModal(hotels.length === 0 ? "add" : "create") });
  } catch (err) {
    log("could not open the form:", err.message);
    await respond(body.response_url, ":x: Could not open the form. Try `/rfpbot` again.");
  }
}

export async function onInteractive({ body, ack }) {
  if (body.type === "block_suggestion") {
    let hotels = [];
    try {
      hotels = loadHotels();
    } catch (err) {
      log("cannot read the hotel list:", err.message);
    }
    await ack({ options: hotelOptions(hotels, body.value) });
    return;
  }
  if (body.type === "block_actions" && body.actions?.some((a) => a.action_id === "rfp_event_type")) {
    // Event-type dropdown posted by the RFP script. Rewriting the message records the pick, which
    // the script reads back, and removes the dropdown so it cannot be answered twice.
    await ack();
    const pick = body.actions.find((a) => a.action_id === "rfp_event_type").selected_option?.value;
    const user = body.user?.id;
    if (pick && allowed(user)) {
      const text = `:white_check_mark: Event type: *${pick}* (picked by <@${user}>)`;
      await api("chat.update", {
        channel: body.container?.channel_id || body.channel?.id,
        ts: body.container?.message_ts || body.message?.ts,
        text,
        blocks: [{ type: "section", text: { type: "mrkdwn", text } }],
      });
    }
    return;
  }
  if (body.type === "block_actions") {
    await ack();
    const picked = body.actions?.find((a) => a.action_id === "action")?.selected_option?.value;
    if (picked in MODE_LABELS && allowed(body.user?.id)) {
      // Redraw the same form for the chosen option (hotel list or name box).
      await api("views.update", { view_id: body.view.id, view: buildModal(picked) });
    }
    return;
  }
  if (body.type === "view_submission" && body.view?.callback_id === CALLBACK_ADD) {
    const user = body.user?.id;
    if (!allowed(user)) {
      await ack({ response_action: "errors", errors: { hotel_name: "You are not allowed to add hotels." } });
      return;
    }
    const result = addHotel(body.view.state?.values?.hotel_name?.hotel_name?.value);
    if (!result.ok) {
      await ack({ response_action: "errors", errors: { hotel_name: result.error } });
      return;
    }
    await ack(); // closes the form
    log(`hotel added: "${result.hotel.name}" (by ${user})`);
    await tell(user, `:heavy_plus_sign: Added *${result.hotel.name}* to the hotel list. It now shows under *Create Guest RFP*.`);
    return;
  }
  if (body.type === "view_submission" && body.view?.callback_id === CALLBACK_CREATE) {
    const user = body.user?.id;
    const picked = body.view.state?.values?.hotel?.hotel?.selected_option?.value;
    const hotel = loadHotels().find((h) => h.id === picked);
    if (!allowed(user)) {
      await ack({ response_action: "errors", errors: { hotel: "You are not allowed to create Guest RFPs." } });
      return;
    }
    if (!hotel) {
      await ack({ response_action: "errors", errors: { hotel: "Pick a hotel from the list." } });
      return;
    }
    await ack(); // closes the form
    await startRfp(user, hotel);
    return;
  }
  await ack();
}

export async function startRfp(user, hotel) {
  const task = getTask(TASK_ID);
  if (!task) {
    await tell(user, `:x: The \`${TASK_ID}\` task is not configured on the server.`);
    return null;
  }
  const input = { venue_name: hotel.venue, slack_channel_id: cfg.channel, requested_by: user };
  const { ok, errors, params } = validateParams(task, input);
  if (!ok) {
    log("rejected:", errors.join("; "));
    await tell(user, `:x: *${hotel.name}* can't be used: ${errors.join("; ")}. Ask the admin to fix its entry in the hotel list.`);
    return null;
  }

  const active = listJobs().filter((j) => j.taskId === TASK_ID && (j.status === "queued" || j.status === "running"));
  const same = active.find((j) => String(j.params?.venue_name || "").toLowerCase() === hotel.venue.toLowerCase());
  if (same) {
    await tell(user, `:information_source: A Guest RFP for *${hotel.name}* is already ${same.status === "running" ? "running" : "queued"}, so I did not start another one.`);
    return null;
  }

  const job = createJob({ taskId: task.id, params });
  enqueue(job);
  tracked.set(job.id, { user, hotel: hotel.name });
  log(`started job ${job.id} for "${hotel.venue}" (requested by ${user})`);
  await tell(
    user,
    active.length === 0
      ? `:rocket: Creating the Guest RFP for *${hotel.name}*. The result will be posted in <#${cfg.channel}>.`
      : `:hourglass: ${active.length} other RFP run(s) come first (one at a time). *${hotel.name}* starts when they finish; the result will be posted in <#${cfg.channel}>.`
  );
  return job;
}

// The RFP script posts submitted / cancelled / failed results itself. This only covers a run that
// ended without any result (the program crashed, timeout, cancelled through the API).
export async function checkJobs() {
  for (const [id, info] of [...tracked]) {
    const job = getJob(id);
    if (!job || !TERMINAL.has(job.status)) continue;
    tracked.delete(id);
    if (job.result) continue;
    try {
      await api("chat.postMessage", {
        channel: cfg.channel,
        text:
          `:x: The Guest RFP run for *${info.hotel}* (requested by <@${info.user}>) stopped without reporting a result (${job.error || job.status}). ` +
          `It may or may not have been submitted, so check the job log (job ${id}) before trying again.`,
      });
    } catch (err) {
      log("could not post the failure:", err.message);
    }
  }
}

// ---- start --------------------------------------------------------------------------------

export async function startSlackBot() {
  if (!cfg.botToken || !cfg.appToken || !cfg.channel) {
    log("disabled: SLACK_BOT_TOKEN, SLACK_APP_TOKEN and SLACK_CHANNEL_ID must all be set");
    return;
  }
  let count = 0;
  try {
    count = loadHotels().length;
  } catch (err) {
    log(`warning: cannot read ${cfg.hotelsFile}: ${err.message}`);
  }

  const client = new SocketModeClient({
    appToken: cfg.appToken,
    clientPingTimeout: 15000,
    serverPingTimeout: 60000,
  });
  let hasConnected = false;
  client.on("reconnecting", () => log("Slack connection interrupted; reconnecting"));
  client.on("connected", () => {
    if (hasConnected) log("Slack connection restored");
    hasConnected = true;
  });
  const safe = (fn) => async (event) => {
    try {
      await fn(event);
    } catch (err) {
      log("handler error:", err.message);
      try {
        await event.ack();
      } catch {
        /* already acknowledged */
      }
    }
  };
  client.on("slash_commands", safe(onSlash));
  client.on("interactive", safe(onInteractive));
  await client.start();
  log(`connected to Slack; /rfpbot lists ${count} hotel(s) from ${cfg.hotelsFile}; results go to ${cfg.channel}`);

  setInterval(() => checkJobs().catch((err) => log("job check failed:", err.message)), 5000).unref();
}
