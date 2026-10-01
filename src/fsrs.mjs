// @ts-check
/**
 * @file FSRS-6 memory model.
 *
 * A faithful, dependency-free port of the FSRS-6 (Free Spaced Repetition
 * Scheduler) memory model. This module is a *model*, not a scheduler: it
 * answers "given a memory state and a review outcome, what is the new memory
 * state?" and "given a memory state and an elapsed time, what is the
 * probability of recall?". It deliberately contains no policy for *when* to
 * review -- that is the job of `solver.mjs`.
 *
 * The equations and the default parameter vector are ported from the reference
 * implementations:
 *   - open-spaced-repetition/py-fsrs  src/fsrs/scheduler.py
 *   - open-spaced-repetition/fsrs-rs  src/model_v6.rs, src/inference_v6.rs
 *
 * `test/fsrs.test.mjs` pins the numeric behaviour against values recomputed by
 * hand from those equations, and asserts the defining identity R(S, S) = 0.9.
 */

import { CrestError } from './errors.mjs';

/** Minimum stability, in days. Mirrors py-fsrs STABILITY_MIN. */
export const STABILITY_MIN = 0.001;
/** Difficulty is confined to [1, 10] in FSRS units. */
export const MIN_DIFFICULTY = 1.0;
export const MAX_DIFFICULTY = 10.0;
/** Upper clamp for the four initial-stability parameters w0..w3. */
export const INITIAL_STABILITY_MAX = 100.0;
/** FSRS-6 learns the forgetting-curve exponent; this is its default. */
export const FSRS6_DEFAULT_DECAY = 0.1542;

/**
 * FSRS-6 default parameter vector (21 weights).
 * Source: fsrs-rs `FSRS6_DEFAULT_PARAMETERS`.
 * @type {readonly number[]}
 */
export const DEFAULT_PARAMETERS = Object.freeze([
  0.212, 1.2931, 2.3065, 8.2956, 6.4133, 0.8334, 3.0194, 0.001, 1.8722, 0.1666,
  0.796, 1.4835, 0.0614, 0.2629, 1.6483, 0.6014, 1.8729, 0.5425, 0.0912, 0.0658,
  FSRS6_DEFAULT_DECAY,
]);

/** @type {readonly number[]} */
export const LOWER_BOUNDS_PARAMETERS = Object.freeze([
  STABILITY_MIN, STABILITY_MIN, STABILITY_MIN, STABILITY_MIN,
  1.0, 0.001, 0.001, 0.001, 0.0, 0.0, 0.001, 0.001, 0.001, 0.001,
  0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.1,
]);

/** @type {readonly number[]} */
export const UPPER_BOUNDS_PARAMETERS = Object.freeze([
  INITIAL_STABILITY_MAX, INITIAL_STABILITY_MAX, INITIAL_STABILITY_MAX,
  INITIAL_STABILITY_MAX, 10.0, 4.0, 4.0, 0.75, 4.5, 0.8, 3.5, 5.0, 0.25, 0.9,
  4.0, 1.0, 6.0, 2.0, 2.0, 0.8, 0.8,
]);

/**
 * Review grades. FSRS indexes these 1..4 and the arithmetic depends on the
 * numeric values (`rating - 3` appears in two equations), so they are not
 * arbitrary labels.
 */
export const Rating = Object.freeze({
  Again: 1,
  Hard: 2,
  Good: 3,
  Easy: 4,
});

/** @type {readonly number[]} */
export const ALL_RATINGS = Object.freeze([
  Rating.Again,
  Rating.Hard,
  Rating.Good,
  Rating.Easy,
]);

/** @type {Readonly<Record<number, string>>} */
export const RATING_NAMES = Object.freeze({
  1: 'Again',
  2: 'Hard',
  3: 'Good',
  4: 'Easy',
});

/**
 * @param {number} value
 * @param {number} lo
 * @param {number} hi
 * @returns {number}
 */
function clamp(value, lo, hi) {
  return Math.min(Math.max(value, lo), hi);
}

/**
 * A point in FSRS memory space.
 * @typedef {object} MemoryState
 * @property {number} stability  Days at which recall probability is 90%.
 * @property {number} difficulty FSRS difficulty in [1, 10].
 */

/**
 * The FSRS-6 memory model, bound to one parameter vector.
 *
 * Instances are immutable and cheap to call; every method is a pure function of
 * its arguments. Methods throw {@link CrestError} rather than returning NaN,
 * because a NaN silently poisons an entire expected-value computation and
 * surfaces hundreds of lines later as an unexplained zero.
 */
export class Fsrs6 {
  /**
   * @param {readonly number[]} [parameters] 21 FSRS-6 weights. Defaults to
   *   {@link DEFAULT_PARAMETERS}. Pass your own (exported from Anki) for
   *   predictions calibrated to your review history.
   */
  constructor(parameters = DEFAULT_PARAMETERS) {
    const w = Fsrs6.validateParameters(parameters);
    /** @type {readonly number[]} */
    this.w = Object.freeze(w);
    /**
     * The forgetting-curve exponent. Negative: retrievability decreases in
     * elapsed time.
     * @type {number}
     */
    this.decay = -w[20];
    /**
     * Chosen so that R(S, S) = 0.9 exactly -- this is what makes "stability"
     * mean "the interval at which recall probability is 90%".
     * @type {number}
     */
    this.factor = Math.pow(0.9, 1 / this.decay) - 1;
  }

  /**
   * Validate a parameter vector against FSRS-6's documented bounds.
   *
   * @param {readonly number[]} parameters
   * @returns {number[]} a defensive copy
   * @throws {CrestError} listing *every* offending index, not just the first --
   *   a user pasting a 21-number vector wants one report, not 21 runs.
   */
  static validateParameters(parameters) {
    if (!Array.isArray(parameters) && !Object.isFrozen(parameters)) {
      throw new CrestError('FSRS parameters must be an array of numbers.');
    }
    const w = Array.from(parameters);
    if (w.length !== LOWER_BOUNDS_PARAMETERS.length) {
      throw new CrestError(
        `FSRS-6 expects ${LOWER_BOUNDS_PARAMETERS.length} parameters, got ${w.length}. ` +
          'FSRS-5 vectors have 19 and FSRS-4.5 vectors have 17; they are not interchangeable.',
      );
    }
    /** @type {string[]} */
    const problems = [];
    for (let i = 0; i < w.length; i += 1) {
      const v = w[i];
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        problems.push(`w[${i}] = ${JSON.stringify(v)} is not a finite number`);
        continue;
      }
      const lo = LOWER_BOUNDS_PARAMETERS[i];
      const hi = UPPER_BOUNDS_PARAMETERS[i];
      if (v < lo || v > hi) {
        problems.push(`w[${i}] = ${v} is outside [${lo}, ${hi}]`);
      }
    }
    if (problems.length > 0) {
      throw new CrestError(
        `Invalid FSRS-6 parameters:\n  ${problems.join('\n  ')}`,
      );
    }
    return w;
  }

  /**
   * Probability of recalling a card whose stability is `stability` after
   * `elapsedDays` have passed since its last review.
   *
   *   R(t, S) = (1 + factor * t / S) ^ decay
   *
   * @param {number} stability
   * @param {number} elapsedDays Non-negative; fractional days are allowed here
   *   (the planner works in whole days, but the model does not require it).
   * @returns {number} a probability in (0, 1]
   */
  retrievability(stability, elapsedDays) {
    const s = Math.max(this.#finite(stability, 'stability'), STABILITY_MIN);
    const t = Math.max(this.#finite(elapsedDays, 'elapsedDays'), 0);
    return Math.pow(1 + (this.factor * t) / s, this.decay);
  }

  /**
   * The interval FSRS would schedule to land exactly on `desiredRetention`.
   * Included for comparison output: it is what Anki would do, and `crest`'s
   * whole point is that it is the wrong question before an exam.
   *
   * @param {number} stability
   * @param {number} desiredRetention in (0, 1)
   * @param {number} [maximumInterval] days
   * @returns {number} whole days, at least 1
   */
  nextInterval(stability, desiredRetention, maximumInterval = 36500) {
    const s = Math.max(this.#finite(stability, 'stability'), STABILITY_MIN);
    const r = this.#finite(desiredRetention, 'desiredRetention');
    if (!(r > 0 && r < 1)) {
      throw new CrestError(`desiredRetention must be in (0, 1), got ${r}.`);
    }
    const raw = (s / this.factor) * (Math.pow(r, 1 / this.decay) - 1);
    return clamp(Math.round(raw), 1, maximumInterval);
  }

  /**
   * Stability of a brand-new card after its first grade.
   * @param {number} rating
   * @returns {number}
   */
  initialStability(rating) {
    this.#checkRating(rating);
    return Math.max(this.w[rating - 1], STABILITY_MIN);
  }

  /**
   * Difficulty of a brand-new card after its first grade.
   *
   *   D0(G) = w4 - exp(w5 * (G - 1)) + 1
   *
   * @param {number} rating
   * @param {boolean} [doClamp] FSRS evaluates this *unclamped* when it uses
   *   D0(Easy) as the mean-reversion target, so the flag is load-bearing rather
   *   than a convenience: with the default parameters the unclamped value is
   *   about -4.77, well outside [1, 10].
   * @returns {number}
   */
  initialDifficulty(rating, doClamp = true) {
    this.#checkRating(rating);
    const d = this.w[4] - Math.exp(this.w[5] * (rating - 1)) + 1;
    return doClamp ? clamp(d, MIN_DIFFICULTY, MAX_DIFFICULTY) : d;
  }

  /**
   * Difficulty after a review, with linear damping and mean reversion.
   * @param {number} difficulty
   * @param {number} rating
   * @returns {number} clamped to [1, 10]
   */
  nextDifficulty(difficulty, rating) {
    const d = this.#finite(difficulty, 'difficulty');
    this.#checkRating(rating);
    const target = this.initialDifficulty(Rating.Easy, false);
    const deltaD = -(this.w[6] * (rating - 3));
    const damped = d + ((10.0 - d) * deltaD) / 9.0;
    const reverted = this.w[7] * target + (1 - this.w[7]) * damped;
    return clamp(reverted, MIN_DIFFICULTY, MAX_DIFFICULTY);
  }

  /**
   * Stability after a *successful* recall (Hard, Good or Easy).
   *
   * The `exp(w10 * (1 - R)) - 1` term is the spacing effect and is the reason a
   * terminal-date planner cannot simply review everything as early as possible:
   * the lower R is when you review, the larger the stability gain.
   *
   * @param {number} difficulty
   * @param {number} stability
   * @param {number} retrievability R at the moment of review
   * @param {number} rating
   * @returns {number} unclamped; callers go through {@link nextStability}
   */
  nextRecallStability(difficulty, stability, retrievability, rating) {
    const d = this.#finite(difficulty, 'difficulty');
    const s = this.#finite(stability, 'stability');
    const r = this.#finite(retrievability, 'retrievability');
    this.#checkRating(rating);
    const hardPenalty = rating === Rating.Hard ? this.w[15] : 1;
    const easyBonus = rating === Rating.Easy ? this.w[16] : 1;
    return (
      s *
      (1 +
        Math.exp(this.w[8]) *
          (11 - d) *
          Math.pow(s, -this.w[9]) *
          (Math.exp((1 - r) * this.w[10]) - 1) *
          hardPenalty *
          easyBonus)
    );
  }

  /**
   * Stability after a lapse (Again).
   *
   * FSRS takes the *minimum* of a long-term estimate and a short-term ceiling,
   * so that a lapse can never be rewarded with more stability than a same-day
   * re-study would have produced.
   *
   * @param {number} difficulty
   * @param {number} stability
   * @param {number} retrievability
   * @returns {number} unclamped
   */
  nextForgetStability(difficulty, stability, retrievability) {
    const d = this.#finite(difficulty, 'difficulty');
    const s = this.#finite(stability, 'stability');
    const r = this.#finite(retrievability, 'retrievability');
    const longTerm =
      this.w[11] *
      Math.pow(d, -this.w[12]) *
      (Math.pow(s + 1, this.w[13]) - 1) *
      Math.exp((1 - r) * this.w[14]);
    const shortTermCeiling = s / Math.exp(this.w[17] * this.w[18]);
    return Math.min(longTerm, shortTermCeiling);
  }

  /**
   * Stability after a review of any grade, clamped.
   * @param {number} difficulty
   * @param {number} stability
   * @param {number} retrievability
   * @param {number} rating
   * @returns {number}
   */
  nextStability(difficulty, stability, retrievability, rating) {
    this.#checkRating(rating);
    const next =
      rating === Rating.Again
        ? this.nextForgetStability(difficulty, stability, retrievability)
        : this.nextRecallStability(difficulty, stability, retrievability, rating);
    return Math.max(next, STABILITY_MIN);
  }

  /**
   * Stability after a *same-day* repeat (a relearning step after a lapse, or a
   * second look within the learning steps). No retrievability term: on the same
   * day there has been no measurable forgetting.
   *
   *   S' = S * max(1, exp(w17 * (G - 3 + w18)) * S^(-w19))   for G >= Hard
   *
   * @param {number} stability
   * @param {number} rating
   * @returns {number}
   */
  shortTermStability(stability, rating) {
    const s = this.#finite(stability, 'stability');
    this.#checkRating(rating);
    let increase =
      Math.exp(this.w[17] * (rating - 3 + this.w[18])) * Math.pow(s, -this.w[19]);
    if (rating >= Rating.Hard) {
      increase = Math.max(increase, 1.0);
    }
    return Math.max(s * increase, STABILITY_MIN);
  }

  /**
   * @param {number} value
   * @param {string} name
   * @returns {number}
   */
  #finite(value, name) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new CrestError(
        `FSRS-6: ${name} must be a finite number, got ${JSON.stringify(value)}.`,
      );
    }
    return value;
  }

  /** @param {number} rating */
  #checkRating(rating) {
    if (rating !== 1 && rating !== 2 && rating !== 3 && rating !== 4) {
      throw new CrestError(
        `rating must be 1 (Again), 2 (Hard), 3 (Good) or 4 (Easy), got ${JSON.stringify(rating)}.`,
      );
    }
  }
}
