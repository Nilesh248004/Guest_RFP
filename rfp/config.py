# Fixed values used on every RFP

ROOMS = {"single": 10, "double": 20}
ATTENDEES = 50

# Change "Dinner" to "Breakfast" when needed
AGENDA = [
    {"name": "General Session", "av_required": True},
    {"name": "Dinner", "av_required": False},
]

CONTACT = {
    "first_name": "HippoVideo",
    "last_name": "Demo",
    "phone": "FILL_ME_IN",
    "state": "FILL_ME_IN",
    "city": "FILL_ME_IN",
    "country": "FILL_ME_IN",
}

EMAIL_PREFIX = "hippovideo"
EMAIL_DOMAIN = "hippovideo.io"
ORG_BASE_NAME = "HippoVideo Demo"
ORG_TYPE = "Other"
INDUSTRY = "Computers and Electronics"
TELL_US_MORE = "This is a Guest RFP"

MIN_DAYS_AHEAD = 35      # arrival is at least this many days after today
EVENT_LENGTH_DAYS = 3      # departure = arrival + this many days
SAME_VENUE_GAP_DAYS = 7    # next RFP for the same venue starts 7 days after the previous one departs
REPLY_BY_DAYS = 7        # "hear from venues by" = 7 days from today