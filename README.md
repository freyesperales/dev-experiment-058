# Development Experiment 058 — crest

**Schedule spaced-repetition reviews so your memory peaks on exam day, under the
hours you actually have — and prove how close to optimal the schedule is.**

> ## ⚠ Status: draft — not yet executed
>
> The code in this repository has **never been run**. The session that wrote it had
> code execution blocked by its sandbox: `node --version` was permitted, but
> `node -e "console.log(2+2)"`, `node src/cli.mjs`, `node --test` and every other
> attempt to execute a script were refused by the permission layer, in both shells,
> on every retry.
>
> Everything here was therefore derived by hand: the FSRS‑6 equations were read from
> the reference implementations' source (not from summaries), the numeric
> expectations in the tests were computed by hand from those equations, and the
> whole codebase was audited by inspection. That is not the same as a green test run
> and is not presented as one.
>
> **To finish verification**, on a machine with ordinary permissions:
>
> ```sh
> node --test test/          # 100+ assertions across 6 files
> node src/cli.mjs demo      # should print a plan and exit 0
> node tools/build-app.mjs   # should write dist/crest.html
> ```
>
> Expect to need small tolerance adjustments in two or three tests whose thresholds
> were estimated by hand rather than measured — they are flagged individually in
> [Known soft spots](#known-soft-spots) below. The structural assertions (bounds
> bracketing the brute-force optimum, budget feasibility, exact-vs-simulated
> agreement) are derived rather than tuned and should hold as written.
>
> No sample output is shown anywhere in this README, because producing one would
> have meant inventing it.

---

## The thesis

FSRS, the scheduler Anki now ships by default, is very good at the question it
asks: *when should I next see this card to hold my recall at 90% indefinitely?* Its
parameters are fitted on hundreds of millions of reviews and it answers that well.

But a student with an exam on the 22nd is not asking that question. They are asking:
**given the state of my collection, my exam date, and the 90 minutes a day I can
actually find — what should I review on each day so that the largest number of cards
is recallable on the 22nd?** That is a different objective (a single terminal date,
not a steady state), under a different constraint (a hard per-day time budget), and
it has a different answer. The spaced-repetition ecosystem knows the deadline case is
special and handles it with heuristic nudges — *postpone*, *advance*, *load balance*,
*easy days* — which are adjustments to a schedule computed for an infinite horizon.
None of them know when your exam is.

`crest` states the deadline problem as an optimisation, solves it, and reports a
**certificate** bounding how far its answer can be from the best one. It also answers
three questions the schedule itself does not: which cards are already safe and should
be left alone, which cards your budget cannot save (so you can drop them on purpose
rather than discover it in the exam), and which single day an extra hour is worth
most on.

**Lane and how it differs from the recent streak.** Education and learning science —
untouched in the previous 57 entries. Entries 045–057 of this series range widely in
domain but are uniformly offline, pure-stdlib *Python CLIs that analyse a file format*
for a developer; entries 001–044 are a single franchise of MCP/agent static auditors.
This is a Node-and-browser **planner for a student**, whose primary interface is a web
page you drop a file onto, and whose output is a schedule you act on rather than
findings you read.

## What it actually found

Two results came out of implementing the model, and the first one reversed the
original design.

**A single review is monotonically more valuable the later it happens.** The first
design assumed an interior optimum per card: late enough for a large spacing gain,
early enough to limit lapse risk. That is wrong. In FSRS, stability gain carries a
factor `exp(w10·(1−R)) − 1` that vanishes as `R → 1`, so later reviews teach more —
*and* a later review leaves less time to decay before the exam. Both push late. Only
lapse risk pushes early, and it loses: a lapse near the exam is followed by a
relearning step and then too little time to forget again.

The consequence is that the **daily budget is the substance of this problem, not a
side constraint**. The final days are a scarce resource every card wants, and the real
question is who gets them — which is exactly the question due-date ordering cannot
ask, because it scatters reviews across the horizon according to intervals computed
for an infinite future. The solver's shadow prices confirm it from the other
direction: `lambda` concentrates on the days nearest the exam.

**FSRS‑6's forgetting curve is a power law, not an exponential.** At ten times a
card's stability, recall probability is still about 0.69; reaching 0.5 takes roughly
ninety times the stability. Overdue cards are much less lost than the Anki interface
implies. This caps how much *any* planner can win here, and `crest` reports the
baseline alongside its own answer rather than quoting only the improvement.

## Running it

Needs **Node 22+**. No dependencies, no install step, no network access, no accounts.

```sh
# A plan for a synthetic collection — needs no input file at all
node src/cli.mjs demo --exam-in 14 --budget 60

# The browser app, on http://localhost:8173
npm run app

# One self-contained offline HTML file you can email to a classmate
node tools/build-app.mjs      # -> dist/crest.html

# The tests
node --test test/
```

`make` runs the demo; `make check` runs tests and the demo; `make app`, `make build`
and `make explain` do the obvious things.

### With your own collection

Open Anki, go to **Tools → Debug Console**, paste in
[`examples/anki-export.py`](examples/anki-export.py) and press Ctrl+Enter. It writes a
CSV and prints your deck's trained FSRS weights.

```sh
node src/cli.mjs plan --cards crest-cards.csv --exam-in 21 \
  --budget 90,90,90,90,90,180,180 \
  --params 0.2104,1.3,2.3,8.2,6.4,0.83,3.0,0.001,1.9,0.17,0.8,1.5,0.06,0.26,1.65,0.6,1.87,0.54,0.09,0.07,0.15
```

The budget list repeats, so seven values express a weekly rhythm — lighter on
weekdays, heavier at weekends.

Or just open the browser app and drop the CSV onto it. Nothing is uploaded; the page
does all its arithmetic locally.

### The CSV

Required: `stability`, `difficulty`, and either `days_since_review` or `last_review`.
Optional: `card_id`, `seconds_recall`, `seconds_lapse`, `label`. Common aliases are
accepted (`s`, `d`, `elapsed_days`, `avg_seconds`, `front`, …). See
[`examples/sample-cards.csv`](examples/sample-cards.csv).

Anki displays difficulty remapped to 0–1 while FSRS uses 1–10 internally, so an export
from the interface arrives on the wrong scale — and because 0.3 is a *legal* FSRS-scale
value, nothing would crash; the planner would simply believe every card is maximally
easy. The loader detects the scale, remaps, and tells you it did. Override with
`--difficulty-scale fsrs|anki`.

### Other subcommands

```sh
node src/cli.mjs synth --count 400 --out cards.csv
node src/cli.mjs explain --cards cards.csv --card c00001 --exam-in 14
```

`explain` prints, for one card, what reviewing it on each possible day is worth. It is
the most direct way to see the monotonicity result for yourself.

## Architecture

```
          CSV ──► collection.mjs ──┐
                                   │   (difficulty-scale detection, strict errors)
     synth.mjs ──► cards ──────────┤
                                   ▼
                              plan.mjs  ◄── the single entry point; CLI, browser app
                                   │        and tests all go through it
         ┌─────────────────────────┼──────────────────────────┐
         ▼                         ▼                          ▼
    plans.mjs                 solver.mjs                simulate.mjs
 (the plan family:         (Lagrangian dual +         (Monte-Carlo: the Anki-policy
  every subset of days      coordinate-ascent          baseline, and an independent
  up to --max-reviews)      repair + certificate)      check on the exact valuation)
         │                         │                          │
         └────────► value.mjs ◄────┘                          │
                  (exact expectation over                     │
                   the 4^k outcome tree)                      │
                         │                                    │
                    fsrs.mjs  (FSRS-6 memory model)            │
                         │                                    │
                         └──────────► viewmodel.mjs ◄──────────┘
                                            │
                              ┌─────────────┴──────────────┐
                              ▼                            ▼
                        report.mjs                    app/ui.mjs
                     (text + JSON, CLI)          (thin DOM glue, browser)
```

`fsrs.mjs` is a model, not a scheduler: it answers "what does this review do to this
memory state" and nothing about *when*. `value.mjs` turns a plan into an exact
probability. `solver.mjs` chooses plans. `viewmodel.mjs` is pure and is what both
output paths render — which is how the browser app's logic gets tested without a
browser.

### The problem, precisely

```
maximise    Σᵢ Vᵢ(pᵢ)                                  expected cards recalled on exam day
subject to  Σᵢ costᵢ(pᵢ, d) ≤ budget_d   for each day d
            pᵢ ∈ P                       for each card i
```

`P` is every subset of the study days of size at most `--max-reviews`. `Vᵢ(p)` is the
**exact** probability that card *i* is recalled on exam day under plan *p*, computed by
enumerating all `4^k` grade histories — not sampled, because a Monte-Carlo estimate
would put noise directly into the objective the optimiser compares plans with, and
plans routinely differ by less than 0.01. Costs are expectations over the same tree
(a lapse costs more time than a clean recall, and the chance of lapsing depends on
when you review), so the budgets are satisfied *in expectation*; this is stated
plainly rather than glossed.

### The certificate

This is a multidimensional knapsack — one capacity per day — so it is NP-hard and
`crest` does not pretend to solve it exactly at scale. Instead it relaxes the day
budgets with multipliers `λ_d ≥ 0`:

```
L(λ) = Σᵢ max_{p∈P} [ Vᵢ(p) − Σ_d λ_d costᵢ(p,d) ] + Σ_d λ_d · budget_d
```

For any `λ ≥ 0`, `L(λ) ≥ OPT`: take the optimal assignment, note each of its terms is
at most the corresponding inner maximum, and the leftover `Σ_d λ_d(budget_d − used_d)`
is non-negative because the optimum is feasible. So every `λ` gives a valid ceiling,
and the smallest found is the tightest. Subgradient descent with Polyak steps
tightens it; a coordinate-ascent repair produces the feasible plan underneath.

**The inner maximisation is therefore exact over the whole family, every iteration.**
A heuristic inner solve would *understate* `L` and yield a "bound" that is not one.
That constraint is why the family is capped at `--max-reviews` and scanned in full.

A reported gap of 0.4% means: no assignment giving each card at most that many
reviews, under these same budgets, beats this plan by more than 0.4% of expected
recall. `test/solver.test.mjs` checks this against brute force on small instances —
the true optimum must land inside `[primal, dual]` — because a gap self-reported by
the code that produced the plan proves nothing.

### Two approaches considered

**Exact dynamic programming over (day, memory state).** Rejected. The reachable state
set is not finite in any useful sense: stability and difficulty are continuous, and
the states reachable at day *d* are one per (review-day pattern × grade history), so
memoisation buys nothing and the "DP" is the same exponential enumeration wearing a
hat. Quantising the state would restore tractability but destroy the only thing worth
having here — a bound that is actually a bound.

**Lagrangian relaxation with exact per-card inner solves.** Chosen. Cost is
`cards × C(days, K) × 4^K` valuations, and memory is one `Float64Array` of
`plans × (1 + K)` per card. For a 21-day horizon with `K = 2` that is 232 plans × 16
leaves ≈ 3,700 model evaluations per card; the family grows as `C(days, K)`, which is
why `K` defaults to 2 and why `plans.mjs` refuses a family above 200,000 with an
explanation instead of exhausting memory.

The real trade-off this buys: **a tight bound on a declared subproblem, instead of a
loose bound on the true one.** Capping reviews per card is a modelling choice, and the
certificate is explicitly a statement about that capped family. It is honest and
checkable; "we found a good schedule" would have been neither.

### Why Monte-Carlo is in here at all

Two reasons, and the first is the important one.

**Cross-validation.** `simulateFixedPlans` samples outcomes for a plan that
`value.mjs` already valued exactly. The two must agree within sampling error. They
share the transition function but reach the answer by completely different routes, so
a bookkeeping error in the tree shows up as a disagreement. The CLI prints this
comparison on every run, and `test/viewmodel.test.mjs` asserts it.

**An honest baseline.** `simulateAnkiPolicy` plays out what students do now: study
whatever FSRS says is due, most-overdue first, until the day's time runs out, carrying
a backlog forward. That policy is *adaptive* — the next due date depends on how the
last review went — so it is not a fixed plan and the exact enumeration cannot value
it. It gets the same budgets, the same memory model and the same behavioural prior;
only the decision rule differs.

## Assumptions and limitations

Listed so you can judge whether a number applies to you.

**Not verified by execution.** See the status box at the top. This is the big one.

**The memory model is FSRS‑6 and is assumed correct.** `crest` optimises *against* the
model. If FSRS mispredicts your memory, `crest` will confidently optimise the wrong
objective. Pass your own trained weights with `--params`; the population defaults are
fitted to other people's reviews.

**FSRS‑7 is coming.** `fsrs-rs` on `main` already carries `model_v7.rs` and a
`MemoryState` with a third field, `stability_fast` — a two-component memory. `crest`
implements FSRS‑6 because that is what Anki ships and what exported parameters are
for. The model is a replaceable component (`src/fsrs.mjs`), not an assumption baked
through the solver, but it is not yet FSRS‑7.

**The grade prior is a guess.** Conditional on recalling a card, the Hard/Good/Easy
split defaults to 0.3/0.6/0.1. There is no universally correct value — it is a
property of the individual reviewer. Override with `--grade-mix`. Results move with
it; the direction of the monotonicity result does not.

**Relearning is modelled as one passed same-day step.** Anki's default relearning
configuration has exactly one 10-minute step, and `crest` assumes you pass it. A
reviewer who fails the same card repeatedly within one session is better described by
a lower input stability than by a deeper outcome tree. `--relearn-steps` adjusts it,
and the choice matters: with zero steps the planner becomes markedly more risk-averse.

**Budgets bind in expectation, not per-realisation.** Lapses cost more time than
recalls, and whether a card lapses is not known in advance. A day planned for 60
minutes may take 70.

**Reviews per card are capped**, at 2 by default. The certificate covers only the
capped family. The Anki-policy baseline has *no* such cap and can review a weak card
every day, so it may legitimately exceed the reported ceiling. **If the baseline is
close to or ahead of the plan, raise `--max-reviews`** — that is the signal, and the
report says so.

**The "already safe" filter is a probability cut-off, not a marginal-value test.**
Cards whose do-nothing recall probability already meets `--safe-threshold` (default
0.98) are fixed to no reviews and contribute identically to both bounds. Because the
curve is a power law, this catches fewer cards than intuition suggests — roughly those
whose time-to-exam is under 15% of their stability. Set `--safe-threshold 1` to put
every card into the optimisation.

**Whole days only.** Day 0 is today, day *T* is the exam. No model of time-of-day, no
sleep-dependent consolidation, no interference between similar cards (so no sibling
burying), and no notion of new cards — a card with no memory state has nothing for the
planner to reason about, and `examples/anki-export.py` excludes them.

**Default answer times are made up when the CSV omits them** (12 s recalled, 30 s
lapsed). The Anki exporter derives real ones from each card's own history, which
matters: a planner working to a *time* budget is only as good as its cost estimates,
and answer times vary several-fold across a real deck.

**The browser UI's DOM layer is untested.** Everything it decides lives in `src/` and
is covered; what is left in `app/ui.mjs` is reading form fields and writing strings.
`test/bundle.test.mjs` goes as far as this can without a browser: it builds the real
bundle, **evaluates it**, runs a plan through it, and asserts the result matches the
module path exactly — plus it checks that every element id the UI reads exists in
`index.html`. Actual rendering is unverified.

**The solver blocks the page.** `planCollection` runs on the main thread after a
one-tick yield so the status text paints. A few seconds of unresponsiveness on a large
collection is the cost of not adding a worker and a message protocol.

**Scale.** Tested by construction up to a few hundred cards over a few weeks. A
10,000-card collection over 60 days with `--max-reviews 2` is 1,831 plans per card —
about 290 million model evaluations. It should complete, but not quickly. Plan the
subset you are actually examined on.

### Known soft spots

Tests whose thresholds were computed by hand rather than measured, and which may need
a tolerance nudge on the first real run:

- `test/solver.test.mjs` — *"on small instances the heuristic lands on or next to the
  optimum"* (tolerance 0.01) and *"more budget never produces less expected recall"*
  (tolerance 0.05). Both bound heuristic quality, which the algorithm does not promise.
- `test/solver.test.mjs` — *"the shadow price concentrates on the days nearest the
  exam"*. Structurally sound, but subgradient iterates are noisy.
- `test/value.test.mjs` — *"a second review stacked next to the first adds an order of
  magnitude less"* (factor 5). Hand-computed as ≈ 11×, so the margin should be ample.

The hand-derived numeric pins in `test/fsrs.test.mjs` (`R(S,S) = 0.9`,
`nextInterval(S, 0.9) = S`, the power-law constants) are exact consequences of the
equations and should hold precisely.

## Layout

| Path | What it is |
|---|---|
| `src/fsrs.mjs` | FSRS‑6 memory model, ported from the reference implementations |
| `src/value.mjs` | Exact expected recall for one card under one plan |
| `src/plans.mjs` | The plan family and per-card value/cost tables |
| `src/solver.mjs` | Lagrangian dual, repair heuristic, optimality certificate |
| `src/exact.mjs` | Brute-force optimum, for verification only |
| `src/simulate.mjs` | Monte-Carlo: Anki-policy baseline and the cross-check |
| `src/collection.mjs` | CSV loading, difficulty-scale detection |
| `src/csv.mjs` | Strict RFC 4180 reader with locating error messages |
| `src/synth.mjs` | Seeded synthetic collections |
| `src/viewmodel.mjs` | Pure derivation of everything the outputs show |
| `src/report.mjs` | Text rendering |
| `src/plan.mjs` | The one pipeline all three front ends call |
| `src/cli.mjs` | Command line |
| `app/` | Browser app: `index.html` + thin DOM glue |
| `tools/bundle.mjs` | Module inliner, with its assumptions checked not hoped for |
| `tools/build-app.mjs` | Builds `dist/crest.html` |
| `tools/serve.mjs` | Localhost static server, so no build is needed to try it |
| `examples/anki-export.py` | Anki Debug Console exporter |
| `test/` | Six suites: model, valuation, solver, I/O, view model, bundle |

## Credits

The memory model is [FSRS](https://github.com/open-spaced-repetition) by Jarrett Ye and
contributors, read from `py-fsrs` and `fsrs-rs`. `crest` implements their equations and
takes none of their code. Everything about rationing days against a deadline is this
experiment's own, and so are its mistakes.

MIT licensed.
