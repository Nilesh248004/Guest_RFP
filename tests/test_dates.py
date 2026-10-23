import json
import os
import sys
import tempfile
import unittest
from datetime import date
from pathlib import Path

os.environ["RFP_STATE_DIR"] = tempfile.mkdtemp(prefix="rfp-state-")   # before importing dates
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "rfp"))
import config  # noqa: E402
import dates  # noqa: E402

START_NUMBER = dates.peek_number()   # read before any test bumps the counter
TODAY = date(2026, 10, 23)
HOTEL = "Sheraton Suites Market Center Dallas"


class Dates(unittest.TestCase):
    def test_first_rfp_is_min_days_ahead_and_counter_is_seeded(self):
        arrival, departure = dates.event_dates(TODAY, "A Brand New Hotel")
        self.assertEqual((arrival - TODAY).days, config.MIN_DAYS_AHEAD)
        self.assertEqual((departure - arrival).days, config.EVENT_LENGTH_DAYS)
        seed = json.loads(Path(dates.__file__).with_name("counter.seed.json").read_text())
        self.assertEqual(START_NUMBER, seed["next_number"])

    def test_consecutive_rfps_for_one_hotel_are_spaced_by_the_gap(self):
        previous_departure = None
        for _ in range(3):
            arrival, departure = dates.event_dates(TODAY, HOTEL)
            self.assertGreaterEqual((arrival - TODAY).days, config.MIN_DAYS_AHEAD)
            if previous_departure:
                self.assertEqual((arrival - previous_departure).days, config.SAME_VENUE_GAP_DAYS)
            before = dates.peek_number()
            dates.bump_number()
            dates.record_event(HOTEL, departure)
            self.assertEqual(dates.peek_number(), before + 1)
            previous_departure = departure

    def test_same_hotel_typed_differently_is_the_same_hotel(self):
        arrival, _ = dates.event_dates(TODAY, "  sheraton SUITES   market center dallas ")
        self.assertEqual((arrival - dates.last_departure(HOTEL)).days, config.SAME_VENUE_GAP_DAYS)

    def test_other_hotels_are_not_affected(self):
        arrival, _ = dates.event_dates(TODAY, "Henderson Beach Resort")
        self.assertEqual((arrival - TODAY).days, config.MIN_DAYS_AHEAD)

    def test_state_files_are_written_atomically(self):
        self.assertEqual(list(dates.STATE_DIR.glob("*.tmp")), [])
        json.loads(dates.COUNTER_FILE.read_text())
        json.loads(dates.VENUE_LOG_FILE.read_text())


if __name__ == "__main__":
    unittest.main()
