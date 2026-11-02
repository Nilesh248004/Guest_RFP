# goose-rfp-bot

Creates **Guest RFPs on Cvent** from Slack. Type `/rfpbot`, pick a hotel, press **Create**; a headless
browser fills in the Cvent request form and the result is posted to a Slack channel.

```
Slack  ──/rfpbot──▶  Node server (Slack Socket Mode)  ──▶  rfp/rfp.py (Playwright, headless Chromium) ──▶  Cvent
  ▲                         │ job queue, logs, API                      │
  └──────── result, screenshots, yes/no questions ◀────────────────────┘
```

No AI model and no public URL are needed: the server connects *out* to Slack (Socket Mode) and the
script is plain Python.

## What it does

- **`/rfpbot` → Create Guest RFP:** a searchable list of the hotels in `config/rfp-hotels.json`.
  Pick one and press **Create**. Only you see a short "creating…" note.
- **`/rfpbot` → Add hotel:** type the hotel's name *exactly as Cvent shows it* and it is added to the list.
  (A misspelled name is only found out when its RFP runs and Cvent has no match; nothing is submitted then.)
- **Confirmations:** before submitting, the script posts the selected venue and the final details to the
  channel and asks you to reply `yes` or `no`. Only the second `yes` submits. No answer within 30 minutes counts as no.
- **Result:** the channel gets *submitted*, *cancelled* or *failed* with a screenshot, the organization
  name, the contact email, the event dates and who asked.
- **Dates:** arrival is at least 35 days out; a second RFP for the same hotel starts at least 7 days after the
  previous one departs (`rfp/config.py`: `MIN_DAYS_AHEAD`, `EVENT_LENGTH_DAYS`, `SAME_VENUE_GAP_DAYS`).
- **One RFP at a time:** a second request for another hotel waits in the queue; the same hotel twice while
  one is active is ignored.
- **Numbering:** each RFP gets the next number (`hippovideo005@hippovideo.io`, `23 OCT HippoVideo Demo 005`).
  The number moves on just before **Submit** is clicked, so a crash never reuses one.

## Setup

Requirements: Node 20+, Python 3.10+.

```bash
npm install
bash scripts/setup.sh            # Python venv, Playwright, Chromium (Linux/Docker: PLAYWRIGHT_WITH_DEPS=1)
cp .env.example .env             # then fill it in (below)
npm start
```

### Slack app (api.slack.com/apps → Create New App → From a manifest → JSON)

```json
{
  "display_information": { "name": "RFP Bot" },
  "features": {
    "bot_user": { "display_name": "RFP Bot", "always_online": false },
    "slash_commands": [
      { "command": "/rfpbot", "description": "Create a Guest RFP", "usage_hint": "(opens a form)", "should_escape": false }
    ]
  },
  "oauth_config": {
    "scopes": { "bot": ["chat:write", "files:write", "channels:history", "groups:history", "channels:read", "groups:read", "commands"] }
  },
  "settings": {
    "interactivity": { "is_enabled": true },
    "org_deploy_enabled": false,
    "socket_mode_enabled": true,
    "token_rotation_enabled": false
  }
}
```

1. Create the app, **Install to Workspace**, copy the **Bot User OAuth Token** (`xoxb-…`) → `SLACK_BOT_TOKEN`.
2. **Basic Information → App-Level Tokens** → generate one with scope `connections:write` (`xapp-…`) → `SLACK_APP_TOKEN`.
3. Invite the bot to the results channel (`/invite @RFP Bot`) and put its ID in `SLACK_CHANNEL_ID`.
4. Set `SLACK_BOT_ENABLED=true` and restart.

Keep token rotation **off**: rotating tokens (`xoxe.…`) expire after 12 hours and the bot has no refresh logic.
Use a bot token (`xoxb-`), not a user token: the script ignores messages from the token's own account.

### `.env`

See `.env.example`. Required: `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `SLACK_CHANNEL_ID`, `SLACK_BOT_ENABLED=true`,
and `API_KEYS` (or `AUTH_DISABLED=true` on a trusted machine). Optional: `SLACK_ALLOWED_USERS` (who may use
`/rfpbot` and add hotels), `RFP_APPROVER` (whose yes/no counts).

## Where things live

| What | Where | Notes |
|---|---|---|
| Hotel list | `config/rfp-hotels.json` (`RFP_HOTELS_CONFIG`) | `{"hotels":[{"name":"Shown in the list","venue_name":"Exact Cvent title (optional)"}]}`. Read each time the form opens. Hotels added from Slack are saved here. |
| RFP counter, per-hotel date log | `state/` (`RFP_STATE_DIR`) | `counter.json`, `venue_log.json`. Seeded from `rfp/counter.seed.json`. **Back this up / keep on a volume.** |
| Job logs and screenshots | `data/jobs/<id>/` (`DATA_DIR`) | `output.log`, `meta.json`, `step*.png`, `failed.png` |

The 7-day gap is tracked by the *venue title*. If you change a hotel's `venue_name` later it counts as a different hotel.

## HTTP API (optional, for operations)

Listens on `127.0.0.1:8787`; send `x-api-key: <key>` (or `Authorization: Bearer`), except `/health`.

| Method | Path | |
|---|---|---|
| GET | `/health` | liveness + queue |
| GET | `/jobs`, `/jobs/:id`, `/jobs/:id/logs` | runs, status, captured output |
| POST | `/jobs/:id/cancel` | stop a queued/running RFP |
| POST | `/tasks/guest-rfp-creation/run` | `{"params":{"venue_name":"<exact Cvent title>"}}` |

Job `status` is `succeeded` only for `RESULT: SUBMITTED`; cancelled, failed and "died without a result" runs are `failed`.

## Deploy

```bash
docker build -t goose-rfp-bot .
docker run -d --name rfp --restart unless-stopped \
  --env-file prod.env -e TZ=Asia/Kolkata -v rfp-state:/data goose-rfp-bot
```

- `prod.env` holds only the secrets/settings above (`HOST`, `DATA_DIR` etc. are set by the image).
- Mount a volume on `/data`: it holds the counter, the venue dates, the hotel list and the job logs.
- Run **exactly one** copy (two would both receive `/rfpbot`, and the one-at-a-time lock is per machine).
- It needs outbound internet only (Slack and Cvent) and about 2 GB RAM for Chromium.
- Set `TZ`: the organization name uses the server's date (`23 OCT …`).
- First deploy: copy your existing `counter.json` and `venue_log.json` into `/data/state/`, otherwise the
  numbering restarts and the 7-day gaps are forgotten.
- Cvent may challenge a headless browser coming from a data-center IP. Test once from `/rfpbot` and answer `no`.

## Tests

```bash
npm test      # Node: job runner + Slack form (mocked Slack, stand-in program); Python: dates/counter
```

The tests never touch Cvent or Slack.

## Troubleshooting

- **`/rfpbot is not a valid command`**: the slash command isn't registered; re-apply the manifest and reinstall the app.
- **Form opens but nothing happens / `dispatch_failed`**: Socket Mode off, or `SLACK_BOT_ENABLED` not `true`.
- **Socket Mode ping/pong timeout warnings**: the bot now allows 15 seconds for a pong and 60 seconds for a server ping, then reconnects automatically. Repeated reconnects still indicate host load or outbound network instability; check container CPU/memory and connectivity to Slack.
- **`channel_not_found` / no messages**: the bot is not in the channel, or `SLACK_CHANNEL_ID` is wrong.
- **`not found among the N results shown`**: the hotel name differs from Cvent's title; fix it in `config/rfp-hotels.json`.
- A run's screenshots and log: `data/jobs/<id>/` (`failed.png` shows where it stopped).
