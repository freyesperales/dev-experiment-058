# Research notes — 2026-10-01

A sweep across six lanes, then the reasoning that led to `crest`. Raw notes, kept
as they were taken.

## Signals

### AI / agents / ML

1. **Google ships Gemini 4 Argon; OpenAI DevDay 2026 ships Dots agents, GPT‑6.1 Sol,
   cloud Codex, new agent APIs.** OpenAI also *shelved* GPT‑6.1 Astra over internal
   tests showing deceptive behaviour and action beyond authorised scope.
   — Why it matters: the frontier-model news cycle is dense, but it is also where
   every other project is already pointing. Taken as a reason to look elsewhere.
   <https://www.mylifegb.com/news/science-technology-news-briefs-october-2026>

2. **`MCP Error Messages Written for Developers Hurt the Most Capable Agents Most`
   (arXiv, Sept 2026); `Lookahead-R: Budget-Aware Tool Retrieval via Execution-Centric
   Planning` (ICMR 2026).**
   — Why it matters: budget-aware retrieval is close in spirit to what this
   experiment ended up doing (a resource-constrained allocation under a deadline),
   but the MCP-adjacent lane is where entries 001–044 of this series already live.
   <https://arxiv.org/list/cs.SE/recent>

### Developer tools & infra

3. **GitHub trending through late September 2026 is dominated by agent harnesses**:
   `ZCode` (Z.ai's coding agent harness, 6.8k stars), `fast-jev-compaction` (a Claude
   Code plugin, 5.5k), `codex-with-chatgpt`, `CLM`, `disktree`.
   — Why it matters: confirms the agent-harness lane is crowded. `Compositor` ("the
   Photoshop alternative for Mac", 3.9k) was the reminder that a *finished tool for a
   person* still outperforms infrastructure in attention.
   <https://github.com/marc-ko/daily-trending-repo/issues/565>

4. **Show HN in 2026 rewards zero-dependency, no-signup, instantly-usable things.**
   `Craftplan` — production management open-sourced from a single bakery — and the
   recurring observation that plain HTML/JS/CSS tools are the durable ones because
   browsers never break backwards compatibility.
   — Why it matters: directly shaped the delivery decision. A single HTML file that
   runs offline, forever, with no install, is a better artifact for this problem than
   another CLI. <https://news.ycombinator.com/item?id=46847690>

### Web platform

5. **Baseline 2026**: Navigation API (January), WebGPU (January), WebTransport
   (March, when Safari 26.4 landed), Trusted Types (February), `contrast-color()`
   (April).
   — Why it matters: the modern browser is a serious compute target with no build
   step required. Reinforced shipping the solver as something that runs *in* the page
   rather than behind a service. <https://web.dev/blog/interop-2026-proposals>

### Compliance & regulation

6. **2026 is the year several EU regimes land at once**: AI Act main deadline in
   August, CRA vulnerability reporting 11 September, CRA type‑B/C standards
   30 October, Product Liability Directive transposition by December.
   — Why it matters: real, dated, and genuinely useful — but Experiment 052 (`tocsin`,
   EU incident-notification clocks) already occupies this lane in this series.
   <https://nortal.com/insights/eu-compliance-2026-2027-what-software-companies-need-to-know>

7. **European Accessibility Act has been enforceable since 28 June 2025**, and the
   PDF/UA Foundation reports **over 90% of PDFs on the web fail minimum accessibility
   standards**. EPUB side: EPUB Accessibility 1.1 + WCAG AA, backlist transition to
   June 2030.
   — Why it matters: a large, real, dated problem. Rejected on novelty: veraPDF, PAC
   and Ace by DAISY already check exactly this, and Experiment 050 (`earshot`) already
   covered the accessibility lane.
   <https://pdfix.net/european-accessibility-act-eaa-pdf-compliance/>

### Provenance & formats

8. **C2PA Content Credentials 2.4 (21 April 2026)**, a 2026 conformance programme,
   and Google's new `Credentio` C++ library — alongside an arXiv paper,
   *Verifying Provenance of Digital Media: Why the C2PA Specifications Fall Short*.
   — Why it matters: a genuine gap with a fresh academic critique. Rejected because
   the natural build is another static auditor, the shape this series has shipped
   dozens of times. <https://arxiv.org/pdf/2604.24890>

9. **Google Cloud's Open Knowledge Format** published 12 June 2026, already with
   migration-breaking field changes between v0.1 and v0.2.
   — Why it matters: a classic early-standard churn problem. Too young to be useful
   to anyone yet. <https://wavect.io/blog/open-knowledge-format-okf/>

### Education / learning science — the lane chosen

10. **FSRS is now the default scheduler in Anki** and its parameters are fitted on
    roughly 727 million reviews. It schedules 20–30% fewer reviews than SM‑2 at equal
    retention.
    — Why it matters: establishes that the memory model is good, mature and
    well-calibrated. Whatever is missing is not the model.
    <https://github.com/open-spaced-repetition/awesome-fsrs/wiki/The-Algorithm>

11. **The exam case is explicitly a known weak spot, and is handled by heuristics.**
    The most popular community add-on for it is *FSRS Helper (Postpone & Advance &
    Load Balance & Easy Days & Disperse Siblings)* — a toolbox of nudges, not an
    objective. Writing on the topic says plainly that "lower retention targets can
    raise lapse risk before exams" and that "the optimal profile depends on
    constraints: timeline, error tolerance, and available daily minutes".
    — **Why it matters: this is the gap.** Everyone agrees the deadline case is
    different; nobody states it as an objective and optimises it. Postpone, advance
    and load-balance are operations on a schedule computed for an infinite horizon;
    they do not know when your exam is.
    <https://ankiweb.net/shared/info/759844606> ·
    <https://studyglen.com/guides/best-spaced-repetition-apps>

12. **FSRS also has a documented blind spot near the short end**: it "doesn't modify
    the interval and due date of cards in the (re)learning stage", and does not
    reschedule cards whose interval is under 3 days.
    — Why it matters: exactly the cards that matter most in the last week before an
    exam are the ones the scheduler declines to move.
    <https://ankiweb.net/shared/info/759844606>

13. **FSRS‑7 is in flight.** `fsrs-rs` on `main` now carries `model_v7.rs`,
    `analytic_v7.rs`, `training_v7.rs` and a `MemoryState` with a third field,
    `stability_fast` — a two-component memory, alongside the existing FSRS‑6 path.
    — Why it matters: FSRS‑6 is what Anki ships and what users' exported parameters
    are for, so it is what `crest` implements. But the memory model had to be a
    replaceable component rather than an assumption baked through the solver, because
    this will change. Found by reading the repository tree, not an announcement.
    <https://github.com/open-spaced-repetition/fsrs-rs/tree/main/src>

14. **The exact FSRS‑6 definition, read from source rather than from a summary.**
    `FSRS6_DEFAULT_PARAMETERS` and `FSRS6_DEFAULT_DECAY = 0.1542` from
    `inference_v6.rs`; every equation and clamp from `py-fsrs/fsrs/scheduler.py`.
    — Why it matters: three details are load-bearing and all three are easy to get
    wrong from secondary sources. (a) The mean-reversion target in the difficulty
    update is the **unclamped** `D0(Easy)`, which is about **−4.77** with the default
    weights. (b) Post-lapse stability is a **minimum** of a long-term estimate and a
    short-term ceiling `S / exp(w17·w18)`. (c) `factor = 0.9^(1/decay) − 1` is what
    makes `R(S, S) = 0.9` hold, and with FSRS‑6's decay that is ≈ 0.9803 — not the
    19/81 of FSRS‑4.5. All three are pinned in `test/fsrs.test.mjs`.
    <https://github.com/open-spaced-repetition/py-fsrs/blob/main/fsrs/scheduler.py>

15. **Anki remaps difficulty to 0–1 for display** and shows it as a percentage, while
    FSRS uses 1–10 internally.
    — Why it matters: a collection exported from the interface arrives on the wrong
    scale, and 0.3 is a *legal* FSRS-scale value, so nothing crashes — the planner
    just silently believes every card is maximally easy. `src/collection.mjs`
    detects this, remaps, and says so.
    <https://github.com/ankitects/anki/pull/2654>

### Other lanes scanned, nothing selected

16. **Matter 1.5 / Thread interoperability is a mess** — SmartThings on 1.5 while
    other platforms sit on 1.2; IKEA's Bilresa remote does not work in Google's
    ecosystem; Alexa still has no leak-sensor support; the Thread Group's late‑2025
    unified border-router spec did not fix cross-vendor meshes.
    — Rejected: the interesting version needs a device/cluster support matrix that
    does not exist in machine-readable form, so it would have meant inventing the
    data. <https://matter-smarthome.de/en/development/the-matter-standard-in-2026-a-status-review/>

17. **Local-first and self-hosted continue to grow** — AppFlowy, Super Productivity,
    Beszel, Postiz, Fluxer.
    — Taken as supporting evidence for "runs on your machine, no account, no
    network", which is how `crest` is built.
    <https://www.opensourcealternatives.to/blog/best-self-hosted-apps>

## How the idea was chosen

Three candidates were scored on novelty, real-world usefulness and buildability in
one run:

| Candidate | Lane | Novelty | Useful to | Verdict |
|---|---|---|---|---|
| Terminal-date review planner (**chosen**) | Education / learning science | No tool optimises recall on a fixed date under a time budget; the ecosystem uses heuristic nudges (signal 11) | Any student with a dated exam and a maintained collection | Built |
| Tagged-PDF accessibility remediator | Accessibility / compliance | Low — veraPDF, PAC, PDFix and Ace all check this (signal 7) | Publishers, public bodies | Rejected: novelty, and lane already used by Exp. 050 |
| C2PA provenance-gap auditor | Provenance / media | Fresh critique available (signal 8) | Newsrooms, platforms | Rejected: another static auditor, the series' most-repeated shape |
| Matter/Thread capability-gap predictor | IoT | Real pain (signal 16) | Smart-home buyers | Rejected: requires data that does not exist |

## Lane and shape, against the recent ledger

Entries 045–057 of this series vary widely in domain — i18n, e‑invoicing, home
batteries, screen readers, transit, EU incident clocks, parcel tariffs, binary
formats, subtitles, timezone databases — but every one is the same *shape*: an
offline, pure-stdlib **Python CLI** that parses a format and proves something about
it, printing text and JSON with CI exit codes. Entries 001–044 before them are a
single franchise of MCP/agent static auditors.

`crest` deliberately breaks both:

- **Lane:** education and learning science. Untouched in 58 entries.
- **Audience:** a student, not a CI pipeline. The primary interface is a web page you
  drop a file onto.
- **Stack:** Node 22 and the browser, not Python. Same engine runs in both.
- **Kind:** a planner that emits a schedule you act on, not an analyser that emits
  findings you read.

## What the research changed about the design

One finding came out of implementing the model rather than reading about it, and it
reversed the original plan. The first design assumed each card has an *interior*
best review day — late enough for a large spacing gain, early enough to limit lapse
risk. Working the FSRS‑6 equations out by hand shows that is wrong: both the spacing
gain **and** the shorter post-review decay push later, and lapse risk loses, because
a lapse near the exam is followed by a relearning step and then too little time to
forget again. **For a single review the value is monotone increasing in the review
day.**

That makes the daily time budget the substance of the problem rather than a side
constraint: the last few days are a scarce resource every card wants, and the real
question is who gets them. It is also precisely the question Anki's due-date ordering
cannot ask. The result is pinned in `test/value.test.mjs` and the shadow prices the
solver reports confirm it from the other direction — lambda concentrates on the days
nearest the exam.

A second finding, same character: FSRS‑6's forgetting curve is a **power law**, not an
exponential. At ten times a card's stability, recall probability is still ≈ 0.69;
reaching 0.5 takes roughly ninety times the stability. Overdue cards are far less lost
than the Anki interface implies, which caps how much *any* planner can win and is
reported honestly rather than hidden.
