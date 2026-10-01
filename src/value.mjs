// @ts-check
/**
 * @file Exact valuation of a single card's review plan.
 *
 * A *plan* for a card is a strictly increasing list of whole-day offsets on
 * which that card will be reviewed, drawn from {0, 1, ..., T-1} where day T is
 * the exam. The *value* of a plan is the probability that the card is recalled
 * on day T.
 *
 * That probability is not a single forward simulation, because a review has a
 * random outcome and the outcome changes the memory state. With k reviews and
 * four possible grades there are 4^k distinct histories; this module enumerates
 * all of them and takes the exact expectation. For the plan sizes `crest`
 * considers (k <= 3 by default) that is at most 64 leaves, which is cheap, so
 * the default is exact rather than sampled -- a Monte-Carlo estimate here would
 * put noise directly into the objective the optimiser is comparing plans with,
 * and plans frequently differ in value by less than 0.01.
 *
 * ## Why the terminal objective behaves differently
 *
 * Three forces act on the choice of review day, and they do not balance the way
 * one might guess:
 *
 *   1. Later is worth more. Stability gain carries a factor exp(w10 * (1 - R)) - 1,
 *      which vanishes as R approaches 1. Reviewing a card you can still recall
 *      perfectly buys almost nothing -- at R = 1 it buys exactly nothing.
 *   2. Later leaves less time to decay. The objective is R at one fixed instant,
 *      and elapsed time since the last review is what erodes it.
 *   3. Later is riskier. Lapse probability is 1 - R, and a lapse replaces
 *      stability with the post-lapse value, a small fraction of what it was.
 *
 * Forces 1 and 2 both push late; only 3 pushes early. Working the FSRS-6 equations
 * out, 3 loses -- because a lapse close to the exam is followed by a relearning
 * step and then barely any time to forget again, so even a lapsed card is likely
 * recalled a day later. The consequence, verified over a sweep in
 * `test/value.test.mjs`, is that **for a single review the value is monotone
 * increasing in the review day**: absent any constraint, review everything on the
 * last possible day.
 *
 * That is why the daily budget is not a detail of this problem but its entire
 * substance. The final days are a scarce resource, every card wants them, and the
 * planner's real job is rationing them -- deciding which cards get a late slot,
 * which must settle for an early one, and which are not worth a slot at all.
 * Anki's due-date ordering is indifferent to all of this: it scatters reviews
 * across the horizon according to intervals computed for an infinite future, and
 * spends the valuable late days on whatever happens to come due then.
 */

import { Fsrs6, Rating } from './fsrs.mjs';
import { CrestError, invariant } from './errors.mjs';

/**
 * A card to be planned for.
 * @typedef {object} Card
 * @property {string} id              Stable identifier (Anki card id, or any string).
 * @property {number} stability       FSRS stability in days, > 0.
 * @property {number} difficulty      FSRS difficulty in [1, 10].
 * @property {number} daysSinceReview Whole days since the last review, >= 0.
 * @property {number} secondsRecall   Expected seconds to answer when recalled.
 * @property {number} secondsLapse    Expected seconds to answer when lapsed
 *                                    (includes the relearning step).
 * @property {string} [label]         Human-facing note, carried through to reports.
 */

/**
 * The result of valuing one plan.
 * @typedef {object} PlanValue
 * @property {number} value       Probability of recall on exam day, in [0, 1].
 * @property {number[]} dayCosts  Expected seconds spent, aligned index-for-index
 *                                with the plan's day list.
 * @property {number} prunedMass  Probability mass of histories that were not
 *                                expanded. Zero when `epsilon` is 0.
 * @property {number} leaves      Histories actually expanded (a cost measure).
 */

/**
 * Conditional grade distribution given that the card *was* recalled.
 * @typedef {object} RecallGradeMix
 * @property {number} hard
 * @property {number} good
 * @property {number} easy
 */

/**
 * Anki's own simulator needs the same prior and there is no universally correct
 * value: it is a property of the individual reviewer. These defaults sit in the
 * middle of commonly reported distributions and are documented as an assumption
 * in the README. Override with `--grade-mix`.
 * @type {RecallGradeMix}
 */
export const DEFAULT_GRADE_MIX = Object.freeze({
  hard: 0.3,
  good: 0.6,
  easy: 0.1,
});

/**
 * @param {RecallGradeMix} mix
 * @returns {RecallGradeMix} normalised so the three weights sum to 1
 */
export function normaliseGradeMix(mix) {
  const entries = /** @type {const} */ (['hard', 'good', 'easy']);
  for (const key of entries) {
    const v = mix[key];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
      throw new CrestError(
        `grade mix "${key}" must be a finite number >= 0, got ${JSON.stringify(v)}.`,
      );
    }
  }
  const total = mix.hard + mix.good + mix.easy;
  if (!(total > 0)) {
    throw new CrestError('grade mix must have a positive total weight.');
  }
  return Object.freeze({
    hard: mix.hard / total,
    good: mix.good / total,
    easy: mix.easy / total,
  });
}

/**
 * Validate a card, throwing a message that names the offending field and the
 * card it came from. Called once per card at load time, not in the inner loop.
 *
 * @param {unknown} candidate
 * @param {string} [where] Context for the error message, e.g. a CSV line.
 * @returns {Card}
 */
export function validateCard(candidate, where = '') {
  const suffix = where ? ` (${where})` : '';
  if (typeof candidate !== 'object' || candidate === null) {
    throw new CrestError(`card must be an object${suffix}.`);
  }
  const c = /** @type {Record<string, unknown>} */ (candidate);
  const id = c.id;
  if (typeof id !== 'string' || id.length === 0) {
    throw new CrestError(`card id must be a non-empty string${suffix}.`);
  }
  /**
   * @param {string} field
   * @param {number} lo
   * @param {number} hi
   * @returns {number}
   */
  const num = (field, lo, hi) => {
    const v = c[field];
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw new CrestError(
        `card ${id}: ${field} must be a finite number, got ${JSON.stringify(v)}${suffix}.`,
      );
    }
    if (v < lo || v > hi) {
      throw new CrestError(
        `card ${id}: ${field} = ${v} is outside the valid range [${lo}, ${hi}]${suffix}.`,
      );
    }
    return v;
  };
  const daysSinceReview = num('daysSinceReview', 0, 1e6);
  if (!Number.isInteger(daysSinceReview)) {
    throw new CrestError(
      `card ${id}: daysSinceReview must be a whole number of days, got ${daysSinceReview}${suffix}.`,
    );
  }
  return {
    id,
    stability: num('stability', 1e-6, 1e6),
    difficulty: num('difficulty', 1, 10),
    daysSinceReview,
    secondsRecall: num('secondsRecall', 0, 3600),
    secondsLapse: num('secondsLapse', 0, 3600),
    label: typeof c.label === 'string' ? c.label : undefined,
  };
}

/**
 * Values plans for one fixed problem instance (one exam date, one model, one
 * behavioural prior). Reusing an instance across cards amortises the grade
 * distribution setup and keeps the hot loop allocation-free apart from the
 * returned arrays.
 */
export class Valuer {
  /**
   * @param {object} options
   * @param {Fsrs6} options.model
   * @param {number} options.examInDays Day index of the exam, >= 1. Study days
   *   are 0 (today) through examInDays - 1.
   * @param {RecallGradeMix} [options.gradeMix]
   * @param {number} [options.relearnSteps] Same-day repeats after a lapse.
   *   Anki's default relearning configuration has exactly one (a 10-minute
   *   step), which is why 1 is the default here. Set 0 to model a reviewer who
   *   abandons lapsed cards for the day.
   * @param {number} [options.epsilon] Skip histories whose probability falls
   *   below this. 0 (the default) means exact.
   */
  constructor({
    model,
    examInDays,
    gradeMix = DEFAULT_GRADE_MIX,
    relearnSteps = 1,
    epsilon = 0,
  }) {
    if (!(model instanceof Fsrs6)) {
      throw new CrestError('Valuer requires an Fsrs6 model instance.');
    }
    if (!Number.isInteger(examInDays) || examInDays < 1) {
      throw new CrestError(
        `examInDays must be a whole number >= 1, got ${JSON.stringify(examInDays)}. ` +
          'Use 1 for "the exam is tomorrow"; there is nothing to plan for an exam today.',
      );
    }
    if (!Number.isInteger(relearnSteps) || relearnSteps < 0 || relearnSteps > 8) {
      throw new CrestError(
        `relearnSteps must be a whole number in [0, 8], got ${JSON.stringify(relearnSteps)}.`,
      );
    }
    if (typeof epsilon !== 'number' || !(epsilon >= 0) || epsilon >= 1) {
      throw new CrestError(`epsilon must be in [0, 1), got ${JSON.stringify(epsilon)}.`);
    }
    this.model = model;
    this.examInDays = examInDays;
    this.gradeMix = normaliseGradeMix(gradeMix);
    this.relearnSteps = relearnSteps;
    this.epsilon = epsilon;
  }

  /**
   * Retrievability on exam day if the card is never reviewed again.
   * This is the "do nothing" baseline and also the quantity that decides
   * whether a card needs any attention at all.
   *
   * @param {Card} card
   * @returns {number}
   */
  baselineValue(card) {
    return this.model.retrievability(
      card.stability,
      card.daysSinceReview + this.examInDays,
    );
  }

  /**
   * Exact expected recall on exam day under `planDays`, plus the expected time
   * the plan consumes on each of its days.
   *
   * @param {Card} card
   * @param {readonly number[]} planDays Strictly increasing, all in [0, examInDays).
   * @returns {PlanValue}
   */
  valuePlan(card, planDays) {
    this.#checkPlan(planDays);
    const dayCosts = new Array(planDays.length).fill(0);
    const state = { value: 0, prunedMass: 0, leaves: 0 };
    this.#walk(card, planDays, 0, card.stability, card.difficulty, -card.daysSinceReview, 1, dayCosts, state);

    // The expectation is over a probability distribution: the reported value
    // plus the mass we declined to expand must bracket the truth.
    invariant(
      state.value >= -1e-9 && state.value <= 1 + 1e-9,
      'plan value escaped [0, 1]',
      { cardId: card.id, value: state.value, plan: planDays.join(',') },
    );
    return {
      value: Math.min(Math.max(state.value, 0), 1),
      dayCosts,
      prunedMass: state.prunedMass,
      leaves: state.leaves,
    };
  }

  /**
   * Depth-first expansion of the outcome tree.
   *
   * @param {Card} card
   * @param {readonly number[]} planDays
   * @param {number} index           Which review we are at.
   * @param {number} stability
   * @param {number} difficulty
   * @param {number} lastReviewDay   Day index of the most recent review; negative
   *                                 for reviews that happened before today.
   * @param {number} prob            Probability of reaching this node.
   * @param {number[]} dayCosts      Accumulator, aligned with planDays.
   * @param {{value: number, prunedMass: number, leaves: number}} acc
   * @returns {void}
   */
  #walk(card, planDays, index, stability, difficulty, lastReviewDay, prob, dayCosts, acc) {
    if (index === planDays.length) {
      acc.leaves += 1;
      const elapsed = this.examInDays - lastReviewDay;
      acc.value += prob * this.model.retrievability(stability, elapsed);
      return;
    }

    const day = planDays[index];
    const elapsed = day - lastReviewDay;
    const sameDay = elapsed < 1;
    const r = this.model.retrievability(stability, elapsed);

    // Expected time this review costs, weighted by the chance of getting here.
    dayCosts[index] += prob * (r * card.secondsRecall + (1 - r) * card.secondsLapse);

    for (const [rating, conditional] of this.ratingBranches(r)) {
      const branchProb = prob * conditional;
      if (branchProb <= 0) continue;
      if (branchProb < this.epsilon) {
        acc.prunedMass += branchProb;
        continue;
      }
      const next = this.transition(stability, difficulty, r, rating, sameDay);
      this.#walk(
        card, planDays, index + 1,
        next.stability, next.difficulty, day,
        branchProb, dayCosts, acc,
      );
    }
  }

  /**
   * The outcome distribution of a review attempted at retrievability `r`.
   *
   * Exposed because the Monte-Carlo simulator in `simulate.mjs` must sample from
   * exactly the distribution the exact valuation integrates over -- if the two
   * ever drifted apart, the cross-validation test comparing them would stop
   * meaning anything.
   *
   * @param {number} r
   * @returns {[number, number][]} `[rating, probability]` pairs summing to 1
   */
  ratingBranches(r) {
    return [
      [Rating.Again, 1 - r],
      [Rating.Hard, r * this.gradeMix.hard],
      [Rating.Good, r * this.gradeMix.good],
      [Rating.Easy, r * this.gradeMix.easy],
    ];
  }

  /**
   * Apply one review to a memory state, including the same-day relearning steps
   * that follow a lapse.
   *
   * Modelling the relearning step matters more than it looks. Without it a lapse
   * is close to total loss and the planner becomes pathologically risk-averse,
   * cramming everything early. In Anki a lapsed card reappears ten minutes later
   * and, answered Good, picks up a short-term stability bump -- so a lapse two
   * weeks before the exam is a setback, not a write-off, and the planner is
   * correspondingly willing to let cards decay for the larger spacing gain.
   *
   * @param {number} stability
   * @param {number} difficulty
   * @param {number} retrievability R at review time
   * @param {number} rating
   * @param {boolean} sameDay Whether under a day has elapsed since the previous
   *   review, in which case FSRS uses its short-term rather than long-term form.
   * @returns {{stability: number, difficulty: number}}
   */
  transition(stability, difficulty, retrievability, rating, sameDay) {
    let s;
    if (sameDay && rating !== Rating.Again) {
      s = this.model.shortTermStability(stability, rating);
    } else {
      s = this.model.nextStability(difficulty, stability, retrievability, rating);
    }
    let d = this.model.nextDifficulty(difficulty, rating);

    if (rating === Rating.Again) {
      // Relearning steps happen the same day. We assume they are passed -- a
      // reviewer who keeps failing the same card within one session is better
      // described by a lower stability input than by a deeper outcome tree.
      for (let i = 0; i < this.relearnSteps; i += 1) {
        s = this.model.shortTermStability(s, Rating.Good);
        d = this.model.nextDifficulty(d, Rating.Good);
      }
    }
    return { stability: s, difficulty: d };
  }

  /** @param {readonly number[]} planDays */
  #checkPlan(planDays) {
    if (!Array.isArray(planDays)) {
      throw new CrestError('a plan must be an array of whole-day offsets.');
    }
    let previous = -1;
    for (const day of planDays) {
      if (!Number.isInteger(day) || day < 0 || day >= this.examInDays) {
        throw new CrestError(
          `plan day ${JSON.stringify(day)} is not a whole number in [0, ${this.examInDays}). ` +
            'Day 0 is today and day ' + this.examInDays + ' is the exam itself.',
        );
      }
      if (day <= previous) {
        throw new CrestError(
          `plan days must be strictly increasing, got ${previous} then ${day}.`,
        );
      }
      previous = day;
    }
  }
}
