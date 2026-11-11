import argparse
import fcntl
import os
import re
import sys

import config
import dates
import slack_notify
from playwright.sync_api import sync_playwright, Error as PWError, TimeoutError as PWTimeout


def shot(page, name):
    page.screenshot(path=f"{name}.png")
    print("Saved", f"{name}.png")


def shot_full(page, name):
    page.screenshot(path=f"{name}.png", full_page=True)
    print("Saved", f"{name}.png")


def dismiss_cookie_banner(page):
    try:
        page.get_by_role("button", name=re.compile("accept", re.I)).first.click(timeout=3000)
        print("Cookie banner dismissed")
    except PWTimeout:
        print("No cookie banner found")


def open_find_venues(page):
    page.goto("https://www.cvent.com")
    page.wait_for_load_state()
    dismiss_cookie_banner(page)

    page.goto("https://www.cvent.com/venues")
    page.wait_for_load_state()

    print("Now on:", page.url)
    shot(page, "step1")

def enter_venue_name(page, venue):
    venue = venue.strip()
    box = page.locator("#SEARCH_TERM")
    box.wait_for(state="visible", timeout=10000)
    box.focus()
    box.press_sequentially(venue, delay=50)
    print("Entered venue:", venue)
    page.wait_for_timeout(2000)
    shot(page, "step2")

    words = re.split(r"[\s\-]+", venue.strip())
    name = re.compile(r"\W+".join(map(re.escape, words)), re.I)
    option = page.get_by_text(name).first
    try:
        option.wait_for(state="visible", timeout=8000)
        print("Selecting suggestion:", option.inner_text().replace("\n", " "))
        option.click()
    except PWTimeout:
        print("No suggestions shown, searching with typed text")

    page.locator('[data-cvent-id="search-bar-search-button"]').click()
    page.wait_for_load_state()
    print("Now on:", page.url)
    shot(page, "step3")


FORM_NAV_TIMEOUT_MS = 30000
FORM_NAV_ATTEMPTS = 3


def request_quotes(page):
    link = page.locator('[data-cvent-id="shopping-cart-submit-request"]')
    # Cvent sometimes accepts the click but never opens the form (the page stays on the
    # results), so click again from a freshly opened cart instead of failing the run.
    for attempt in range(1, FORM_NAV_ATTEMPTS + 1):
        if not link.first.is_visible():
            # the link sits inside the cart dropdown, which is closed after selecting the venue
            page.locator('[data-cvent-id="shopping-cart-button"]').first.click()
            page.wait_for_timeout(1000)
        try:
            link.first.wait_for(state="visible", timeout=15000)
        except PWTimeout:
            shot(page, "step4_cart")
            raise
        link.first.click()
        try:
            # "commit" = the form's URL was reached; the load event is awaited separately
            # below because Cvent's form page can be slow to finish loading
            page.wait_for_url("**/rfp-form/**", wait_until="commit", timeout=FORM_NAV_TIMEOUT_MS)
            break
        except PWError as e:   # a timeout, or the navigation itself failing (net::ERR_...)
            print(f"Attempt {attempt}/{FORM_NAV_ATTEMPTS}: Submit request did not open the form "
                  f"({str(e).splitlines()[0]}); still on {page.url[:150]}")
            try:   # best effort: a screenshot must never stop the retry
                page.screenshot(path=f"step4_attempt{attempt}.png", timeout=5000)
            except PWError:
                pass
            if attempt == FORM_NAV_ATTEMPTS:
                raise PWTimeout(f"Submit request did not open the RFP form after {attempt} tries; "
                                f"still on {page.url[:150]} (see step4_attempt{attempt}.png)")
    try:
        page.wait_for_load_state("load", timeout=60000)
    except PWTimeout:
        pass
    try:
        page.wait_for_load_state("networkidle", timeout=20000)
    except PWTimeout:
        pass
    page.wait_for_timeout(2000)
    print("Now on:", page.url)
    shot(page, "step5")
    continue_as_guest(page)


def continue_as_guest(page):
    btn = page.locator('[data-cvent-id="venueSummary-continueAsGuest"]')
    btn.wait_for(state="visible", timeout=20000)
    btn.click()
    try:
        page.wait_for_load_state("networkidle", timeout=20000)
    except PWTimeout:
        pass
    page.wait_for_timeout(2000)
    print("Now on:", page.url)
    shot(page, "step6")
    fill_event_details(page)


def choose_event_type(page):
    """Offer Cvent's own event types as a Slack dropdown; the venue is already confirmed."""
    labels = [o.strip() for o in page.locator("select#type option").all_inner_texts()]
    labels = [l for l in labels if l and not re.match(r"(select|choose)\b", l, re.I)]
    picked = slack_notify.ask_choice(
        f"Venue confirmed: *{RUN['venue']}*. Which *event type* should this RFP use?", labels)
    if not picked:
        raise Cancelled("No event type was chosen.")
    return picked


def fill_event_details(page):
    event_type = choose_event_type(page)
    page.locator("select#type").select_option(label=event_type)
    RUN["event_type"] = event_type
    print("Event type:", event_type)

    arrival, departure = dates.event_dates(venue=RUN["venues"])
    RUN["arrival"], RUN["departure"] = arrival, departure
    print(f"Event: {arrival:%m/%d/%Y} -> {departure:%m/%d/%Y}")
    start, end = arrival.strftime("%m/%d/%Y"), departure.strftime("%m/%d/%Y")
    for field, value in (("#startDate", start), ("#endDate", end)):
        box = page.locator(field)
        box.click()
        box.fill(value)
        box.press("Tab")  # commit the value and close the date picker
    print("Dates:", start, "->", end)

    page.locator('label[for="areDatesFlexible_0"]').click()   # flexible: Yes
    page.locator('label[for="needSleepingRoom_0"]').click()   # guest rooms: Yes
    page.locator('[data-cvent-id="eventInfo-guestRoomBlock"]').click()

    page.locator('input[id="0.single"]').fill("10")
    page.locator('input[id="0.double"]').fill("20")
    page.locator('[data-cvent-id="eventInfo-sleepingRoomsForm-copyDay"]').first.click()

    tick_all_copy_days(page)
    page.locator('[data-cvent-id="eventInfo-sleepingRoomsForm-copyDayForm-apply"]').click()
    page.wait_for_timeout(1000)
    page.locator('[data-cvent-id="eventInfo-sleepingRoomsForm-close"]').click()
    page.wait_for_timeout(1500)
    shot(page, "step7")

    fill_meeting_space(page)


def tick_all_copy_days(page):
    """In a 'Copy day' dialog, make sure every listed day is ticked."""
    days = page.locator('input[id^="copyDay_"]')
    days.first.wait_for(state="attached", timeout=10000)
    for i in range(days.count()):
        box = days.nth(i)
        label = page.locator(f'label[for="{box.get_attribute("id")}"]')
        if not box.is_checked():
            label.click()
        print(f"{label.inner_text().strip()}: {'checked' if box.is_checked() else 'NOT checked'}")


def set_checkbox(page, box_id, want):
    box = page.locator(f'input[id="{box_id}"]')
    box.wait_for(state="attached", timeout=10000)
    if box.is_checked() != want:
        page.locator(f'label[for="{box_id}"]').click()
    print(f"{box_id}: {'checked' if box.is_checked() else 'unchecked'}")


AGENDA = [
    dict(function="General session", start="11:00 am", end="4:30 pm",
         layout="Conference", attendees="50", av=True, pick_layout=True),
    dict(function="Dinner", start="7:00 pm", end="8:00 pm",
         layout="Buffet", attendees="50", av=False, pick_layout=True),
]


def choose_room_setup(page, item):
    """Offer Cvent's own room setups (theatre, reception, ...) as a Slack dropdown."""
    labels = [o.strip() for o in page.locator("select#setupType option").all_inner_texts()]
    labels = [l for l in labels if l and not re.match(r"(select|choose)\b", l, re.I)]
    picked = slack_notify.ask_choice(
        f"Which *room setup* for the *{item['function']}* ({item['start']} - {item['end']})?", labels,
        action_id="rfp_room_setup", placeholder="Select room setup")
    if not picked:
        raise Cancelled("No room setup was chosen.")
    return picked


def add_agenda_item(page, item):
    page.locator('[data-cvent-id="eventInfo-agendaForm-addItem"]').click()
    page.locator("select#functionType").select_option(label=item["function"])
    page.locator("select#startTime").select_option(label=item["start"])
    page.locator("select#endTime").select_option(label=item["end"])
    if item.get("pick_layout"):
        item["layout"] = choose_room_setup(page, item)
    page.locator("select#setupType").select_option(label=item["layout"])
    page.locator("#attendeeCount").fill(item["attendees"])
    set_checkbox(page, "AVNeeded_0", item["av"])
    page.locator('[data-cvent-id="eventInfo-agendaForm-agendaItemForm-apply"]').click()
    page.wait_for_timeout(1000)
    print("Agenda item added:", item["function"])


def fill_meeting_space(page):
    page.locator('label[for="needMeetingSpace_0"]').click()   # meeting rooms: Yes
    page.locator("#attendeesPerDay").fill("50")
    page.locator('[data-cvent-id="eventInfo-agendaItems"]').click()

    for item in AGENDA:
        add_agenda_item(page, item)

    page.locator('[data-cvent-id="eventInfo-agendaForm-copyDay"]').first.click()
    tick_all_copy_days(page)
    page.locator('[data-cvent-id="eventInfo-agendaForm-copyDay-apply"]').click()
    page.wait_for_timeout(1000)
    shot(page, "step8_agenda")
    page.locator('[data-cvent-id="eventInfo-agendaForm-close"]').click()
    page.wait_for_timeout(1500)
    shot(page, "step8")

    page.locator("#additionalInfo").fill(config.TELL_US_MORE)
    page.locator('[data-cvent-id="eventInfo-nextPage"]').click()
    fill_contact_details(page)


def fill_contact_details(page):
    run = dates.run_values(venue=RUN["venues"])
    n = run["number"]
    page.locator("#email").wait_for(state="visible", timeout=20000)

    set_checkbox(page, "isThirdPartyPlanner_0", True)   # third-party planner: Yes

    page.locator("#firstName").fill(config.CONTACT["first_name"])
    page.locator("#lastName").fill(config.CONTACT["last_name"])
    page.locator("#email").fill(run["email"])
    page.locator("#phone").fill("9433849398")
    page.locator("#city").fill("Mumbai")
    page.locator("select#country").select_option(label="India")
    page.locator("select#state").select_option(label="Maharashtra")
    set_checkbox(page, "accountCreateConsent_0", False)  # no free Cvent account

    page.locator("#plannerOrganizationName").fill("Hippovideo")
    page.locator("#commissionRate").fill("10" if n % 2 == 0 else "7")  # alternates per run
    page.locator("#clientOrganizationName").fill(run["org_name"])
    print("Email:", run["email"], "| Client org:", run["org_name"])

    page.locator("select#clientOrganizationType").select_option(label="Other")
    page.locator("select#clientIndustryType").select_option(label="Computers and electronics")
    due = page.locator("#responseDueDate")
    due.click()
    due.fill(run["reply_by"].strftime("%m/%d/%Y"))
    due.press("Tab")
    page.locator("select#preferredContactMethods").select_option(label="Phone or email")
    set_checkbox(page, "shareConsent_0", True)   # share details with the selected hotels
    page.wait_for_timeout(1000)
    shot(page, "step9")

    page.locator('[data-cvent-id="contactInfo-next"]').click()
    review_and_submit(page, run)


SHOW_MORE = re.compile(r"^\s*show more\s*$", re.I)
CLOSE = re.compile(r"^\s*close\s*$", re.I)


def open_show_more_details(page):
    """Click every 'Show more' and leave the sections open, so the final full-page screenshot shows
    everything. If a 'Show more' opens a pop-up instead of expanding in place, that pop-up is
    screenshotted and read, then closed, so the next one can be opened.
    Returns [(png_path, label, text)] for the pop-ups only."""
    def toggles():
        return page.get_by_text(SHOW_MORE).locator("visible=true")

    found, skip = [], 0
    for _ in range(12):
        before = toggles().count()
        if before <= skip:
            break
        try:
            toggles().nth(skip).click(timeout=3000)
            page.wait_for_timeout(1500)
        except Exception as e:
            print(f"Could not click 'Show more': {e}")
            break
        if toggles().count() < before:
            continue                      # expanded in place; leave it open
        # still there: it opened a pop-up, so capture it and close it
        name = f"step10_detail_{len(found) + 1}"
        shot(page, name)
        text, label = "", f"Details {len(found) + 1}"
        try:
            popup = page.locator('[role="dialog"], .modal, [class*="modal" i]').locator("visible=true").first
            text = popup.inner_text(timeout=2000).strip()
            label = text.splitlines()[0].strip() if text else label
        except Exception:
            pass
        found.append((f"{name}.png", label, text))
        try:
            page.get_by_text(CLOSE).locator("visible=true").first.click(timeout=3000)
        except Exception:
            page.keyboard.press("Escape")
        page.wait_for_timeout(800)
        skip += 1
    print(f"'Show more': {len(found)} pop-up(s); {toggles().count()} left unopened")
    return found


def review_and_submit(page, run):
    """Send the review page to Slack; submit only after a 'yes'."""
    page.locator("#submit-btn").wait_for(state="visible", timeout=30000)
    page.wait_for_timeout(2000)
    popups = open_show_more_details(page)
    shot_full(page, "step10_review")

    body = page.locator("body").inner_text()
    start = body.find("EVENT DETAILS", max(body.find("You're almost finished"), 0))
    end = body.find("Privacy policy")
    details = body[max(start, 0): end if end > 0 else len(body)].strip()
    for _, label, text in popups:
        if text:
            details += f"\n\n--- {label} ---\n{text}"
    if not any(text for _, _, text in popups):
        # the pop-ups could not be read, so list the hidden parts from what the script entered
        details += "\n\nGUEST ROOMS PER NIGHT: 10 single, 20 double"
        details += "\nAGENDA (every day):"
        for item in AGENDA:
            details += (f"\n- {item['function']} {item['start']}-{item['end']}, {item['layout']}, "
                        f"{item['attendees']} attendees, AV {'yes' if item['av'] else 'no'}")
    images = [("step10_review.png", "RFP review page")]
    images += [(path, f"Show more: {label}") for path, label, _ in popups]

    ok = slack_notify.ask_yes_no(
        "Please confirm the RFP details above before it is submitted.",
        images=images,
        details=details,
    )
    if not ok:
        raise Cancelled("RFP details were not confirmed.")

    # Reserve the number and the venue dates BEFORE clicking Submit. If the click or the
    # page after it fails, the RFP may still exist on Cvent, and reusing its email/org
    # number would be worse than skipping one.
    dates.bump_number()
    dates.record_event(RUN["venues"], RUN["departure"])
    print("Counter moved on from", run["number"])
    page.locator("#submit-btn").click()
    page.wait_for_timeout(5000)
    try:
        page.wait_for_load_state("networkidle", timeout=20000)
    except PWTimeout:
        pass
    shot_full(page, "step11_submitted")
    print("Submitted.")
    notify_slack(
        "step11_submitted.png",
        f":white_check_mark: *RFP submitted* for *{RUN['venue']}*\n"
        f"Event type: {RUN['event_type']}\n"
        f"Client org: {run['org_name']}\nContact: {run['email']}\n"
        f"{requested_by_line()}"
        f"Event: {RUN['arrival']:%m/%d/%Y} -> {RUN['departure']:%m/%d/%Y}\n"
        "*What to do:* nothing now. Venues reply to that email address; "
        "run the script again for the next RFP (a repeat venue is dated 7 days after this one).")


def _css_str(s):
    return '"' + s.replace("\\", "\\\\").replace('"', '\\"') + '"'


def _cart_post(r):
    return r.url.endswith("/venues/api/cart") and r.request.method == "POST"


def clear_cart(page):
    """Start from an empty cart: remove every venue left in it, including the target."""
    button = page.locator('[data-cvent-id="shopping-cart-button"]')
    if button.count() == 0 or not re.search(r"\d", button.first.inner_text()):
        return
    button.first.click()
    removes = page.locator('[data-cvent-id="shopping-cart-remove-button"]')
    for _ in range(12):
        if removes.count() == 0:
            break
        with page.expect_response(_cart_post):
            removes.first.click()
        page.wait_for_timeout(1000)
    print("Cart cleared")
    page.keyboard.press("Escape")
    page.wait_for_timeout(500)


def cart_count(page):
    text = page.locator('[data-cvent-id="shopping-cart-button"]').first.inner_text()
    digits = re.findall(r"\d+", text)
    return int(digits[0]) if digits else 0


def select_venue(page, venue, first=True):
    """Add `venue` to the cart. The first venue starts from an empty cart; later ones are added to it."""
    wanted = venue.strip()
    titles = page.locator("h3[title]")
    try:
        titles.first.wait_for(state="visible", timeout=20000)
        page.locator(f'h3[title={_css_str(wanted)}]').first.wait_for(state="visible", timeout=10000)
    except PWTimeout:
        pass  # handled below with a clear message
    if first:
        clear_cart(page)
    expected = len(RUN["selected"]) + 1
    for h3 in titles.all():
        if (h3.get_attribute("title") or "").strip() == wanted:
            # outermost ancestor holding only this one venue title = this venue's card
            card = h3.locator("xpath=ancestor::*[count(.//h3[@title])=1][last()]")
            card.scroll_into_view_if_needed()
            with page.expect_response(_cart_post):
                card.locator('button[aria-label="Select venue"]:visible').first.click()
            page.wait_for_timeout(3000)  # let the cart finish updating
            if cart_count(page) != expected:
                raise RuntimeError(f"Cart holds {cart_count(page)} venues, expected {expected} "
                                   f"after adding {wanted}.")
            RUN["selected"].append(wanted)
            print("Selected venue:", h3.get_attribute("title"))
            shot(page, "step4")
            return
    shot(page, "step4_not_found")
    raise PWTimeout(f"'{venue}' not found among the {titles.count()} results shown (see step4_not_found.png)")


def show_cart(page, count):
    """Open the 'Venues N' cart panel and wait until it lists `count` venues."""
    items = page.locator('[data-cvent-id="shopping-cart-remove-button"]')
    for attempt in range(3):
        if items.count() >= count:
            break
        page.locator('[data-cvent-id="shopping-cart-button"]').first.click()
        try:
            items.nth(count - 1).wait_for(state="visible", timeout=5000)
        except PWTimeout:
            print(f"Cart panel not showing {count} venues yet (attempt {attempt + 1})")
    page.wait_for_timeout(800)


def confirm_venues_and_request(page):
    """Show the cart (every chosen venue) in Slack; only a 'yes' goes on to the request form."""
    RUN["venue"] = ", ".join(RUN["venues"])
    if len(RUN["venues"]) > 1:   # the cart lists all of them; step4.png only shows the last one added
        try:
            show_cart(page, len(RUN["venues"]))
            shot(page, "step4")
            page.keyboard.press("Escape")
            page.wait_for_timeout(500)
        except Exception as e:
            print("Could not photograph the cart:", e)
    names = ", ".join(f"*{v}*" for v in RUN["venues"])
    question = (f"Is this the right venue: {names}?" if len(RUN["venues"]) == 1
                else f"Are these the right {len(RUN['venues'])} venues: {names}?")
    if not slack_notify.ask_yes_no(question, images=[("step4.png", "Venue(s) selected on Cvent")]):
        raise Cancelled("Venue was not confirmed.")
    request_quotes(page)


RUN = {}   # venues and event dates for this run


def advice(error):
    msg = str(error)
    if "not found among" in msg:
        return ("the venue title must match Cvent's title exactly (see the screenshot of the results). "
                "Check the spelling, then run the script again.")
    if "Missing environment" in msg:
        return "set SLACK_BOT_TOKEN and SLACK_CHANNEL_ID, then run again."
    return ("nothing was submitted. Open the screenshot to see where it stopped. Cvent may have "
            "changed or been slow, so run it again; if it stops in the same place, send this "
            "message and screenshot to the developer.")


def requested_by_line():
    """'Requested by: <@U...>' when the Slack form started this run (RFP_REQUESTED_BY), else ''."""
    who = os.environ.get("RFP_REQUESTED_BY", "").strip()
    return f"Requested by: <@{who}>\n" if re.fullmatch(r"[UW][A-Z0-9]{6,}", who) else ""


def notify_slack(image, text):
    """Post text (and a screenshot) to Slack; never let a Slack problem hide the real result."""
    try:
        if image and os.path.exists(image):
            slack_notify.send_image(image, text)
        else:
            slack_notify.send_text(text)
    except Exception as e:
        print("Could not post to Slack:", e)


class Cancelled(Exception):
    """A Slack confirmation was answered 'no' (or timed out): stop, submit nothing."""


def main():
    parser = argparse.ArgumentParser(description="Create a Guest RFP on Cvent for one venue.")
    parser.add_argument("--venue", help="exact venue title as shown on Cvent; several venues separated by |")
    parser.add_argument("--headless", action="store_true", help="run without a visible browser (the default)")
    parser.add_argument("--headed", action="store_true", help="show the browser window while it runs")
    parser.add_argument("--terminal", action="store_true",
                        help="no Slack: confirm yes/no by typing in this terminal")
    parser.add_argument("--relay", action="store_true",
                        help="no Slack token: an agent posts the confirmations (see slack_notify.py)")
    args = parser.parse_args()
    if args.terminal:
        os.environ["RFP_CONFIRM_MODE"] = "terminal"
    elif args.relay:
        os.environ["RFP_CONFIRM_MODE"] = "relay"
    args.headless = not args.headed
    raw = args.venue or input("Enter venue name (several: separate with |): ")
    venues = []
    for v in raw.split("|"):
        v = v.strip()
        if v and v.lower() not in [x.lower() for x in venues]:
            venues.append(v)
    if not venues:
        sys.exit("No venue given.")
    RUN["venues"], RUN["selected"], RUN["venue"] = venues, [], ", ".join(venues)

    slack_notify.check_config()
    result = "FAILED"
    # one RFP run at a time: runs share the counter and the per-venue date log
    lock = open(dates.STATE_DIR / ".rfp.lock", "w")
    fcntl.flock(lock, fcntl.LOCK_EX)
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=args.headless)
        context = browser.new_context()   # fresh cookies and storage on every run
        page = context.new_page()
        try:
            for i, venue in enumerate(venues):
                open_find_venues(page)
                enter_venue_name(page, venue)
                select_venue(page, venue, first=(i == 0))
            confirm_venues_and_request(page)
            result = "SUBMITTED"
        except Cancelled as e:
            result = "CANCELLED"
            print("CANCELLED:", e)
            notify_slack(None, f":no_entry: *RFP cancelled.* {e}\n"
                               "*What to do:* nothing was submitted. Fix whatever was wrong "
                               "(venue name, details) and run the script again when ready.")
        except Exception as e:
            print("FAILED:", e)
            shot_full(page, "failed")
            notify_slack("failed.png", f":x: *RFP automation stopped.* Venue: {RUN.get('venue', '?')}\n"
                                       f"Error: {str(e).splitlines()[0][:300]}\n"
                                       f"*What to do:* {advice(e)}")
        if not args.headless and sys.stdin.isatty():
            input("Press Enter to close...")
        browser.close()
    print(f"RESULT: {result}")
    sys.exit({"SUBMITTED": 0, "CANCELLED": 2}.get(result, 1))


def inspect_page(page):
    print("--- Visible fields on the page ---")
    for el in page.locator("input, textarea, [role=tab], [role=combobox], button").all():
        if el.is_visible():
            tag = el.evaluate("e => e.tagName")
            print(tag, "|", el.get_attribute("placeholder"), "|",
                  el.get_attribute("aria-label"), "|",
                  (el.inner_text() or "")[:40].replace("\n", " "))

if __name__ == "__main__":
    main()