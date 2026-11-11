import json
import os
import re
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


def _as_list(venue):
    """One venue name or a list of them -> list."""
    return [venue] if isinstance(venue, str) else list(venue or [])


def last_departure(venue):
    """Departure date of the latest submitted RFP for this venue (or the latest across several), or None."""
    if not VENUE_LOG_FILE.exists():
        return None
    log = json.loads(VENUE_LOG_FILE.read_text())
    saved = [date.fromisoformat(log[_venue_key(v)]) for v in _as_list(venue) if _venue_key(v) in log]
    return max(saved) if saved else None


def record_event(venue, departure):
    """Call this only after a real, approved submit. Records every venue of the RFP."""
    log = json.loads(VENUE_LOG_FILE.read_text()) if VENUE_LOG_FILE.exists() else {}
    for v in _as_list(venue):
        newest = max(departure, last_departure(v) or departure)
        log[_venue_key(v)] = newest.isoformat()
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


HOTELS_FILE = Path(os.environ.get("RFP_HOTELS_CONFIG")
                   or Path(__file__).resolve().parent.parent / "config" / "rfp-hotels.json")
_SKIP_WORDS = {"a", "an", "and", "at", "by", "for", "in", "of", "the"}


def venue_code(venue):
    """Code for one venue. For an RFP to several venues there is no code (plain naming)."""
    venues = _as_list(venue)
    return _venue_code(venues[0]) if len(venues) == 1 else ""


def _venue_code(venue):
    """Short code for a hotel, e.g. 'Wyndham Indianapolis Airport' -> 'WIA'.

    Uses an optional "code" on the hotel's entry in the hotels file, else the initials of its words
    (ignoring 'by', 'at', 'the'... and anything after ' - ').
    """
    try:
        for h in json.loads(HOTELS_FILE.read_text()).get("hotels", []):
            names = {_venue_key(str(h.get("venue_name") or "")), _venue_key(str(h.get("name") or ""))}
            if h.get("code") and _venue_key(venue) in names:
                return str(h["code"]).strip().upper()
    except (OSError, ValueError, AttributeError):
        pass
    head = (venue or "").split(" - ")[0]
    words = [w for w in re.split(r"[^A-Za-z0-9]+", head) if w and w.lower() not in _SKIP_WORDS]
    return "".join(w[0] for w in words).upper()


def run_values(today=None, venue=None):
    today = today or date.today()
    n = peek_number()
    arrival, departure = event_dates(today, venue)
    return {
        "arrival": arrival,
        "departure": departure,
        "reply_by": today + timedelta(days=config.REPLY_BY_DAYS),
        "email": f"{config.EMAIL_PREFIX}{n:03d}@{config.EMAIL_DOMAIN}",
        "org_name": " ".join(filter(None, [today.strftime('%d %b').upper(), config.ORG_BASE_NAME,
                                          venue_code(venue), f"{n:03d}"])),
        "number": n,
    }


if __name__ == "__main__":
    for key, value in run_values().items():
        print(key, value)