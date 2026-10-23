import json
import os
import shutil
from datetime import date, timedelta
from pathlib import Path

import config

# State (counter + venue log) lives in RFP_STATE_DIR so it survives redeploys. Default: ../state
# (not tracked by git). On first use the bundled counter.seed.json seeds the counter.
STATE_DIR = Path(os.environ.get("RFP_STATE_DIR") or Path(__file__).resolve().parent.parent / "state")
STATE_DIR.mkdir(parents=True, exist_ok=True)
COUNTER_FILE = STATE_DIR / "counter.json"
VENUE_LOG_FILE = STATE_DIR / "venue_log.json"
_SEED = Path(__file__).with_name("counter.seed.json")
if not COUNTER_FILE.exists() and _SEED.exists():
    shutil.copy(_SEED, COUNTER_FILE)


def _write_atomic(path, text):
    """Write to a temp file and rename, so a crash never leaves a half-written state file."""
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(text)
    os.replace(tmp, path)


def _venue_key(venue):
    return " ".join(venue.lower().split())


def last_departure(venue):
    """Departure date of the latest submitted RFP for this venue, or None."""
    if not VENUE_LOG_FILE.exists():
        return None
    saved = json.loads(VENUE_LOG_FILE.read_text()).get(_venue_key(venue))
    return date.fromisoformat(saved) if saved else None


def record_event(venue, departure):
    """Call this only after a real, approved submit."""
    log = json.loads(VENUE_LOG_FILE.read_text()) if VENUE_LOG_FILE.exists() else {}
    key = _venue_key(venue)
    newest = max(departure, last_departure(venue) or departure)
    log[key] = newest.isoformat()
    _write_atomic(VENUE_LOG_FILE, json.dumps(log, indent=2))


def event_dates(today=None, venue=None):
    """Arrival is at least MIN_DAYS_AHEAD out. For a venue that already has an RFP,
    arrival is also at least SAME_VENUE_GAP_DAYS after that RFP's departure."""
    today = today or date.today()
    arrival = today + timedelta(days=config.MIN_DAYS_AHEAD)
    previous = last_departure(venue) if venue else None
    if previous:
        arrival = max(arrival, previous + timedelta(days=config.SAME_VENUE_GAP_DAYS))
    departure = arrival + timedelta(days=config.EVENT_LENGTH_DAYS)
    return arrival, departure


def peek_number():
    """Read the current number without changing it."""
    return json.loads(COUNTER_FILE.read_text())["next_number"]


def bump_number():
    """Call this only after a real, approved submit."""
    data = json.loads(COUNTER_FILE.read_text())
    data["next_number"] += 1
    _write_atomic(COUNTER_FILE, json.dumps(data))


def run_values(today=None, venue=None):
    today = today or date.today()
    n = peek_number()
    arrival, departure = event_dates(today, venue)
    return {
        "arrival": arrival,
        "departure": departure,
        "reply_by": today + timedelta(days=config.REPLY_BY_DAYS),
        "email": f"{config.EMAIL_PREFIX}{n:03d}@{config.EMAIL_DOMAIN}",
        "org_name": f"{today.strftime('%d %b').upper()} {config.ORG_BASE_NAME} {n:03d}",
        "number": n,
    }


if __name__ == "__main__":
    for key, value in run_values().items():
        print(key, value)