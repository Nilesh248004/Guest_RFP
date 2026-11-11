"""Slack confirmations: post details/images, then wait for a "yes" or "no" reply.

Three modes:
  terminal mode       RFP_CONFIRM_MODE=terminal (rfp.py --terminal). Prints the image paths and
                      details and asks you to type yes/no in the terminal. No Slack at all.
  bot mode (default)  this script talks to Slack itself with a bot token.
  relay mode          RFP_CONFIRM_MODE=relay. No token here. Each request is written to
                      relay/<id>.json and "CONFIRM_NEEDED <id> <path>" is printed; an agent
                      with its own Slack tools posts it, and writes yes/no to relay/<id>.answer.

Bot mode needs two environment variables:
  SLACK_BOT_TOKEN   bot token (xoxb-...) with scopes chat:write, files:write,
                    channels:history (public channel) or groups:history (private)
  SLACK_CHANNEL_ID  channel id (C...) the bot has been invited to
"""
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path

from slack_sdk import WebClient

YES = {"yes", "y", "yep", "yeah", "confirm", "confirmed", "approve", "approved", "ok", "okay"}
NO = {"no", "n", "nope", "cancel", "stop", "reject", "rejected"}

TIMEOUT_SECONDS = 30 * 60   # no answer in 30 minutes counts as "no"
POLL_SECONDS = 5


def terminal_mode():
    return os.environ.get("RFP_CONFIRM_MODE") == "terminal"


def _terminal_ask(question, images, details):
    print("\n" + "=" * 60, flush=True)
    print("CONFIRMATION NEEDED:", question.replace("*", ""), flush=True)
    for path, comment in images:
        full = os.path.abspath(path)
        print(f"  image: {full}  ({comment})", flush=True)
        if sys.platform == "darwin":
            subprocess.run(["open", full], check=False)   # show it in Preview
    if details:
        print("-" * 60 + "\n" + details + "\n" + "-" * 60, flush=True)
    while True:
        try:
            reply = input("Type yes to continue or no to cancel: ")
        except EOFError:
            return False
        answer = _answer(reply)
        if answer is not None:
            return answer
        print("Please type yes or no.")


def relay_mode():
    """Relay mode needs no Slack token: an agent with its own Slack tools does the posting."""
    return os.environ.get("RFP_CONFIRM_MODE") == "relay"


def _relay_dir():
    d = Path(os.environ.get("RFP_RELAY_DIR", "relay")).resolve()
    d.mkdir(parents=True, exist_ok=True)
    return d


def _new_id():
    return str(time.time_ns())


def _relay_write(kind, payload, rid=None):
    """Write relay/<id>.json and print a marker line the agent watches for."""
    rid = rid or _new_id()
    payload = dict(payload, id=rid, kind=kind)
    path = _relay_dir() / f"{rid}.json"
    path.write_text(json.dumps(payload, indent=2))
    print(f"{kind.upper()} {rid} {path}", flush=True)
    return rid


def _relay_ask(question, images, details):
    rid = _new_id()
    answer = _relay_dir() / f"{rid}.answer"   # the agent writes "yes" or "no" here
    _relay_write("confirm_needed", {
        "question": question,
        "images": [{"path": str(Path(p).resolve()), "comment": c} for p, c in images],
        "details": details,
        "answer_file": str(answer),
    }, rid=rid)
    deadline = time.time() + TIMEOUT_SECONDS
    while time.time() < deadline:
        if answer.exists():
            result = _answer(answer.read_text())
            if result is not None:
                return result
        time.sleep(POLL_SECONDS)
    _relay_write("notice", {"text": "No answer received in time. Cancelling."})
    return False


def check_config():
    if relay_mode() or terminal_mode():
        return
    missing = [k for k in ("SLACK_BOT_TOKEN", "SLACK_CHANNEL_ID") if not os.environ.get(k)]
    if missing:
        raise SystemExit("Missing environment variable(s): " + ", ".join(missing))


def _client():
    return WebClient(token=os.environ["SLACK_BOT_TOKEN"])


def _channel():
    return os.environ["SLACK_CHANNEL_ID"]


def send_image(path, comment):
    if terminal_mode():
        print(f"\n[NOTICE] {comment}\n  image: {os.path.abspath(path)}", flush=True)
        return
    if relay_mode():
        _relay_write("notice", {"text": comment, "image": str(Path(path).resolve())})
        return
    _client().files_upload_v2(channel=_channel(), file=path,
                              title=os.path.basename(path), initial_comment=comment)


def send_text(text):
    if terminal_mode():
        print(f"\n[NOTICE] {text}", flush=True)
        return {"ts": "0"}
    if relay_mode():
        _relay_write("notice", {"text": text})
        return {"ts": "0"}
    return _client().chat_postMessage(channel=_channel(), text=text)


def _answer(text):
    words = (text or "").strip().lower().split()
    word = re.sub(r"[^a-z]", "", words[0]) if words else ""
    if word in YES:
        return True
    if word in NO:
        return False
    return None


def ask_yes_no(question, images=(), details=None):
    """Post images/details, ask `question`, and return True (yes) or False (no / timeout).

    Anyone in the channel can answer, in the channel or in the question's thread, unless
    RFP_APPROVER (a Slack user ID) is set: then only that person's answer counts.
    """
    if terminal_mode():
        return _terminal_ask(question, images, details)
    if relay_mode():
        return _relay_ask(question, images, details)
    client = _client()
    me = client.auth_test()["user_id"]
    approver = (os.environ.get("RFP_APPROVER") or "").strip()   # Slack user ID; blank = anyone

    for path, comment in images:
        send_image(path, comment)
    if details:
        for i in range(0, len(details), 3500):   # send everything, in chunks, never truncate
            send_text(f"```{details[i:i + 3500]}```")

    posted = send_text(f"{question}\nReply *yes* to continue or *no* to cancel.")
    ts = posted["ts"]

    deadline = time.time() + TIMEOUT_SECONDS
    while time.time() < deadline:
        time.sleep(POLL_SECONDS)
        found = client.conversations_history(channel=_channel(), oldest=ts, limit=50)["messages"]
        found += client.conversations_replies(channel=_channel(), ts=ts)["messages"]
        for m in sorted(found, key=lambda m: float(m["ts"])):
            if float(m["ts"]) <= float(ts) or m.get("user") == me or m.get("bot_id"):
                continue
            if approver and m.get("user") != approver:
                continue
            answer = _answer(m.get("text"))
            if answer is not None:
                return answer
    send_text("No answer received in time. Cancelling.")
    return False


CHOICE_PICKED = re.compile(r"(?:Event type|Room setup): \*(.+?)\*")


def ask_choice(question, options, action_id="rfp_event_type", placeholder="Select event type"):
    """Ask for one of `options` (list of strings) and return the pick, or None on timeout.

    Slack: posts a dropdown. The Socket Mode bot (src/slack-bot.js) turns the message into
    "Event type: *<pick>*" (or "Room setup: *<pick>*") when someone chooses, and this function reads that back.
    """
    if terminal_mode():
        print("\n" + question.replace("*", ""), flush=True)
        for i, o in enumerate(options, 1):
            print(f"  {i}. {o}", flush=True)
        while True:
            try:
                reply = input("Type the number of your choice: ").strip()
            except EOFError:
                return None
            if reply.isdigit() and 1 <= int(reply) <= len(options):
                return options[int(reply) - 1]
            print("Please type one of the numbers above.")
    if relay_mode():
        rid = _new_id()
        answer = _relay_dir() / f"{rid}.answer"   # the agent writes the chosen option here
        _relay_write("choice_needed", {"question": question, "options": options,
                                       "answer_file": str(answer)}, rid=rid)
        deadline = time.time() + TIMEOUT_SECONDS
        while time.time() < deadline:
            if answer.exists() and answer.read_text().strip() in options:
                return answer.read_text().strip()
            time.sleep(POLL_SECONDS)
        return None

    client = _client()
    posted = client.chat_postMessage(
        channel=_channel(), text=question,
        blocks=[
            {"type": "section", "text": {"type": "mrkdwn", "text": question}},
            {"type": "actions", "block_id": action_id, "elements": [{
                "type": "static_select", "action_id": action_id,
                "placeholder": {"type": "plain_text", "text": placeholder},
                "options": [{"text": {"type": "plain_text", "text": o[:75]}, "value": o[:150]}
                            for o in options[:100]],
            }]},
        ])
    ts = posted["ts"]
    deadline = time.time() + TIMEOUT_SECONDS
    while time.time() < deadline:
        time.sleep(POLL_SECONDS)
        msgs = client.conversations_history(channel=_channel(), latest=ts, inclusive=True, limit=1)["messages"]
        m = CHOICE_PICKED.search(msgs[0].get("text", "")) if msgs else None
        if m and m.group(1) in options:
            return m.group(1)
    send_text("No choice made in time. Cancelling.")
    return None
