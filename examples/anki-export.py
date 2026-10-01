"""Export an Anki deck's FSRS memory states to the CSV crest reads.

HOW TO RUN
----------
In Anki: Tools -> Debug Console (Ctrl+Shift+; on Windows/Linux, Cmd+Shift+; on
macOS). Paste this whole file in and press Ctrl+Enter. It writes `crest-cards.csv`
next to your Anki data folder and prints the path.

Requires FSRS to be enabled in Anki (Deck Options -> FSRS). Without it, cards have
no stability or difficulty to export and the script will tell you so.

WHAT IT DOES
------------
For each card in the chosen search, it reads `card.memory_state`, which is Anki's
FSRS state: stability in days and difficulty. Two details matter and are handled
here rather than left to trip you up:

  * Anki's `memory_state.difficulty` is on the FSRS 1-10 scale internally, but the
    interface displays it remapped to 0-100%. This script writes the FSRS-scale
    value, and crest's loader will confirm which scale it detected.
  * `seconds_recall` is taken from each card's own review history rather than
    assumed, because a planner working to a *time* budget is only as good as its
    cost estimates, and answer times vary several-fold across a real deck.

Also prints your deck's trained FSRS-6 weights, if it has any. Pass them to crest
with --params so the predictions are calibrated to you rather than to the
population defaults.

THE SEARCH
----------
Edit SEARCH below. It is an ordinary Anki browser search:

    "deck:Pharmacology"            one deck
    "deck:Pharm::Cardio -is:new"   a subdeck, excluding new cards
    "tag:boards -is:suspended"     by tag

New cards are excluded regardless: they have no memory state, so there is nothing
for the planner to reason about. Add them to your study plan separately.
"""

import csv
import os

SEARCH = "deck:current -is:new -is:suspended"
OUTPUT = "crest-cards.csv"

try:
    from aqt import mw
except ImportError as exc:  # pragma: no cover - only reachable outside Anki
    raise SystemExit(
        "This script must be run inside Anki's Debug Console, not as a standalone "
        "Python file: it needs Anki's own collection object."
    ) from exc

col = mw.col
if col is None:
    raise SystemExit("No collection is open.")

card_ids = col.find_cards(SEARCH)
if not card_ids:
    raise SystemExit(
        f"No cards matched {SEARCH!r}. Try the search in the browser first to check it."
    )

today_cutoff = col.sched.day_cutoff  # epoch seconds at which "today" ends
rows = []
without_state = 0

for cid in card_ids:
    card = col.get_card(cid)
    state = getattr(card, "memory_state", None)
    if state is None:
        without_state += 1
        continue

    # Elapsed whole days since the last review. Anki stores revlog times in
    # milliseconds; using the scheduler's day cutoff keeps this consistent with
    # what Anki itself considers "today", including a custom day-start hour.
    last_ms = col.db.scalar(
        "select max(id) from revlog where cid = ? and ease > 0", cid
    )
    if last_ms is None:
        without_state += 1
        continue
    days_since_review = max(0, int((today_cutoff - last_ms / 1000) // 86400))

    # Median-ish answer time from this card's own history, in seconds. revlog.time
    # is milliseconds and can be absurd when someone left the app open, so it is
    # clamped before averaging.
    times = col.db.list(
        "select time from revlog where cid = ? and ease > 0 order by id desc limit 10",
        cid,
    )
    clamped = [min(max(t / 1000.0, 1.0), 120.0) for t in times] or [12.0]
    seconds_recall = round(sum(clamped) / len(clamped), 2)

    rows.append(
        {
            "card_id": str(cid),
            "stability": round(float(state.stability), 4),
            "difficulty": round(float(state.difficulty), 4),
            "days_since_review": days_since_review,
            "seconds_recall": seconds_recall,
            "seconds_lapse": round(min(seconds_recall * 2.5 + 6, 300.0), 2),
            "label": col.get_note(card.nid).fields[0][:60].replace("\n", " "),
        }
    )

if not rows:
    raise SystemExit(
        "Matched cards, but none had an FSRS memory state and a review history.\n"
        "Enable FSRS in Deck Options and use 'Optimize' once, then re-run this."
    )

path = os.path.join(os.path.dirname(col.path), OUTPUT)
with open(path, "w", newline="", encoding="utf-8") as handle:
    writer = csv.DictWriter(handle, fieldnames=list(rows[0].keys()))
    writer.writeheader()
    writer.writerows(rows)

print(f"wrote {len(rows)} cards to {path}")
if without_state:
    print(f"skipped {without_state} card(s) with no FSRS state or no review history")

# Your own trained weights, if the deck preset has them. Worth passing to crest:
# the defaults are fitted to hundreds of millions of other people's reviews.
try:
    conf = col.decks.config_dict_for_deck_id(col.decks.selected())
    params = conf.get("fsrsParams6") or conf.get("fsrsWeights") or []
    if params:
        print("\nYour FSRS weights - pass them to crest with --params:")
        print(",".join(str(round(float(p), 4)) for p in params))
    else:
        print("\nThis deck preset has no trained FSRS weights; crest will use the defaults.")
except Exception as exc:  # noqa: BLE001 - informational only, must not abort the export
    print(f"\n(could not read FSRS weights: {exc})")

print(
    "\nNext:\n"
    f"  crest plan --cards {path} --exam-in 21 --budget 90\n"
    "or open the browser app and drop the file onto it."
)
