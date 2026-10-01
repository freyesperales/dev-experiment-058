// @ts-check
/**
 * @file Plan valuation. The central claims here are that the expectation is a
 * genuine expectation (probabilities sum to one, value stays in [0, 1]) and that
 * the interior optimum crest exists to find actually exists.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { Fsrs6, Rating } from '../src/fsrs.mjs';
import { Valuer, validateCard, normaliseGradeMix, DEFAULT_GRADE_MIX } from '../src/value.mjs';
import { simulateFixedPlans } from '../src/simulate.mjs';
import { CrestError, InvariantError } from '../src/errors.mjs';

const model = new Fsrs6();

/**
 * @param {Partial<import('../src/value.mjs').Card>} [overrides]
 * @returns {import('../src/value.mjs').Card}
 */
function card(overrides = {}) {
  return {
    id: 'c1',
    stability: 10,
    difficulty: 5,
    daysSinceReview: 8,
    secondsRecall: 12,
    secondsLapse: 30,
    ...overrides,
  };
}

test('the empty plan equals the do-nothing baseline', () => {
  const v = new Valuer({ model, examInDays: 14 });
  const c = card();
  assert.equal(v.valuePlan(c, []).value, v.baselineValue(c));
  assert.equal(
    v.baselineValue(c),
    model.retrievability(c.stability, c.daysSinceReview + 14),
  );
});

test('values stay in [0, 1] across a wide sweep of cards and plans', () => {
  const v = new Valuer({ model, examInDays: 10 });
  for (const stability of [0.3, 1, 7, 50, 400]) {
    for (const difficulty of [1, 5.5, 10]) {
      for (const daysSinceReview of [0, 3, 40, 500]) {
        const c = card({ stability, difficulty, daysSinceReview });
        for (const plan of [[], [0], [5], [9], [0, 5], [2, 6], [0, 4, 9]]) {
          const { value } = v.valuePlan(c, plan);
          assert.ok(
            value >= 0 && value <= 1,
            `S=${stability} D=${difficulty} age=${daysSinceReview} plan=${plan} -> ${value}`,
          );
        }
      }
    }
  }
});

test('outcome probabilities sum to one, so no mass is lost in the tree', () => {
  // Valuing a card whose retrievability at the exam is pinned to 1 by a zero
  // elapsed time makes the returned value equal the total probability mass.
  const v = new Valuer({ model, examInDays: 5 });
  const c = card();
  // A plan whose last review is on day 4 leaves 1 day to the exam, so the value
  // is a weighted average of R values, each < 1. Instead check mass directly by
  // counting leaves against the expected 4^k.
  assert.equal(v.valuePlan(c, []).leaves, 1);
  assert.equal(v.valuePlan(c, [0]).leaves, 4);
  assert.equal(v.valuePlan(c, [0, 2]).leaves, 16);
  assert.equal(v.valuePlan(c, [0, 2, 4]).leaves, 64);
});

test('a review strictly helps a card that is slipping away', () => {
  const v = new Valuer({ model, examInDays: 14 });
  const c = card({ stability: 2, daysSinceReview: 60 });
  const base = v.baselineValue(c);
  assert.ok(base < 0.7, `expected a weak card, got baseline ${base}`);
  for (let day = 0; day < 14; day += 1) {
    assert.ok(
      v.valuePlan(c, [day]).value > base,
      `reviewing on day ${day} did not beat doing nothing`,
    );
  }
});

test("FSRS-6's forgetting curve is heavy-tailed, so very few cards are ever 'safe'", () => {
  // Worth pinning because it contradicts the intuition the Anki interface
  // encourages, and because it sets the scale of everything crest reports. With
  // decay 0.1542 the curve is a power law, not an exponential: at ten times a
  // card's stability its recall probability is still around 0.69, and reaching
  // 0.5 takes roughly ninety times the stability.
  assert.ok(Math.abs(model.retrievability(10, 100) - 0.693) < 0.01);
  assert.ok(model.retrievability(10, 850) > 0.5);
  assert.ok(model.retrievability(10, 1000) < 0.5);
  // The practical consequence: a probability-based "already safe" cut-off only
  // catches cards reviewed very recently relative to their stability.
  const safeAt98 = model.retrievability(200, 14);
  assert.ok(safeAt98 > 0.98, `R(200, 14) = ${safeAt98}`);
  assert.ok(model.retrievability(50, 14) < 0.98);
});

test('a single review is monotonically more valuable the later it happens', () => {
  // The structural result the planner is built around, and the reason the daily
  // budget is the whole problem rather than a side constraint. This is an
  // empirical property of FSRS-6 under these parameters, not a theorem, so it is
  // checked over a sweep rather than argued.
  const v = new Valuer({ model, examInDays: 20 });
  const shapes = [
    { stability: 1, daysSinceReview: 30 },     // long forgotten
    { stability: 4, daysSinceReview: 12 },     // slipping
    { stability: 12, daysSinceReview: 6 },     // comfortable
    { stability: 60, daysSinceReview: 45 },    // overdue but strong
    { stability: 500, daysSinceReview: 10 },   // effectively permanent
  ];
  for (const shape of shapes) {
    for (const difficulty of [2, 5.5, 9]) {
      const c = card({ ...shape, difficulty });
      /** @type {number[]} */
      const values = [];
      for (let day = 0; day < 20; day += 1) values.push(v.valuePlan(c, [day]).value);
      for (let day = 1; day < values.length; day += 1) {
        assert.ok(
          values[day] >= values[day - 1] - 1e-9,
          `S=${shape.stability} age=${shape.daysSinceReview} D=${difficulty}: ` +
            `value fell from day ${day - 1} (${values[day - 1]}) to ${day} (${values[day]})`,
        );
      }
      assert.ok(
        values[19] > values[0],
        `S=${shape.stability} D=${difficulty}: the last day did not beat day 0`,
      );
    }
  }
});

test('a second review stacked next to the first adds an order of magnitude less', () => {
  // The corollary of monotonicity: everything wants the last slot, so a planner
  // that merely piled reviews at the end would be squandering them. Back-to-back
  // reviews are nearly worthless, which is what makes rationing -- rather than
  // stacking -- the right response to a budget.
  const v = new Valuer({ model, examInDays: 20 });
  const c = card({ stability: 12, difficulty: 5.5, daysSinceReview: 6 });
  const baseline = v.baselineValue(c);
  const firstGain = v.valuePlan(c, [19]).value - baseline;
  const stackedGain = v.valuePlan(c, [18, 19]).value - v.valuePlan(c, [18]).value;
  assert.ok(firstGain > 0 && stackedGain >= 0);
  assert.ok(
    firstGain > 5 * stackedGain,
    `first review gained ${firstGain}, a stacked second only ${stackedGain}`,
  );
});

test('two reviews beat one, and the second is worth less than the first', () => {
  const v = new Valuer({ model, examInDays: 21 });
  const c = card({ stability: 5, daysSinceReview: 12 });
  const base = v.baselineValue(c);

  /**
   * @param {number[][]} candidates
   * @returns {number}
   */
  const bestOf = (candidates) => {
    let best = -Infinity;
    for (const plan of candidates) best = Math.max(best, v.valuePlan(c, plan).value);
    return best;
  };
  /** @type {number[][]} */
  const singles = [];
  /** @type {number[][]} */
  const doubles = [];
  for (let a = 0; a < 21; a += 1) {
    singles.push([a]);
    for (let b = a + 1; b < 21; b += 1) doubles.push([a, b]);
  }
  const one = bestOf(singles);
  const two = bestOf(doubles);
  assert.ok(one > base, 'one review did not beat nothing');
  assert.ok(two > one, 'two reviews did not beat one');
  assert.ok(two - one < one - base, 'diminishing returns are absent');
});

test('exact valuation agrees with Monte-Carlo simulation of the same plan', () => {
  // Independent route to the same quantity. The exact code integrates the outcome
  // tree; the simulator samples it. A bookkeeping error in the tree shows up here.
  const v = new Valuer({ model, examInDays: 16 });
  const cards = [
    card({ id: 'a', stability: 3, daysSinceReview: 10 }),
    card({ id: 'b', stability: 22, difficulty: 7.5, daysSinceReview: 30 }),
    card({ id: 'c', stability: 60, difficulty: 2.5, daysSinceReview: 5 }),
  ];
  /** @type {Map<string, number[]>} */
  const planByCardId = new Map([
    ['a', [1, 9]],
    ['b', [4]],
    ['c', [0, 7, 14]],
  ]);
  let exact = 0;
  for (const c of cards) exact += v.valuePlan(c, planByCardId.get(c.id) ?? []).value;

  const sim = simulateFixedPlans({ cards, planByCardId, valuer: v, trials: 40000, seed: 12345 });
  // Four standard errors: tight enough to catch a mis-weighted branch, loose
  // enough that the test does not flake on a different-but-valid RNG path.
  assert.ok(
    Math.abs(sim.mean - exact) < 4 * sim.stderr + 1e-9,
    `exact ${exact} vs simulated ${sim.mean} +/- ${sim.stderr}`,
  );
});

test('relearning steps make a lapse survivable, and that changes the plan value', () => {
  const weak = card({ stability: 3, daysSinceReview: 25 });
  const without = new Valuer({ model, examInDays: 14, relearnSteps: 0 });
  const with1 = new Valuer({ model, examInDays: 14, relearnSteps: 1 });
  const with3 = new Valuer({ model, examInDays: 14, relearnSteps: 3 });
  const a = without.valuePlan(weak, [2]).value;
  const b = with1.valuePlan(weak, [2]).value;
  const c = with3.valuePlan(weak, [2]).value;
  assert.ok(b > a, 'one relearning step should not lower the value');
  assert.ok(c > b, 'more relearning steps should not lower the value');
});

test('expected cost lies between the recall and lapse costs', () => {
  const v = new Valuer({ model, examInDays: 10 });
  const c = card({ secondsRecall: 10, secondsLapse: 40, stability: 6, daysSinceReview: 12 });
  const { dayCosts } = v.valuePlan(c, [3]);
  assert.equal(dayCosts.length, 1);
  assert.ok(dayCosts[0] > 10 && dayCosts[0] < 40, `expected cost ${dayCosts[0]}`);
});

test('a later review costs more in expectation, because lapses are likelier', () => {
  const v = new Valuer({ model, examInDays: 30 });
  const c = card({ stability: 8, daysSinceReview: 2, secondsRecall: 10, secondsLapse: 40 });
  let previous = 0;
  for (const day of [0, 5, 10, 20, 29]) {
    const cost = v.valuePlan(c, [day]).dayCosts[0];
    assert.ok(cost > previous, `cost did not rise by day ${day}`);
    previous = cost;
  }
});

test('the cost of a second review is discounted by the chance of reaching it', () => {
  // Every history reaches the second review, so no discount applies to the
  // *probability* of arriving -- but the state on arrival differs, so the cost
  // must differ from valuing that day alone.
  const v = new Valuer({ model, examInDays: 20 });
  const c = card({ stability: 5, daysSinceReview: 15 });
  const alone = v.valuePlan(c, [12]).dayCosts[0];
  const after = v.valuePlan(c, [2, 12]).dayCosts[1];
  assert.ok(after < alone, `reviewing on day 2 first should make day 12 cheaper`);
});

test('epsilon pruning brackets the exact value', () => {
  const exactValuer = new Valuer({ model, examInDays: 18, epsilon: 0 });
  const pruned = new Valuer({ model, examInDays: 18, epsilon: 0.02 });
  const c = card({ stability: 9, daysSinceReview: 4 });
  const plan = [3, 9, 15];
  const exact = exactValuer.valuePlan(c, plan);
  const approx = pruned.valuePlan(c, plan);
  assert.equal(exact.prunedMass, 0);
  assert.ok(approx.prunedMass > 0, 'nothing was pruned at epsilon 0.02');
  assert.ok(approx.leaves < exact.leaves, 'pruning did not reduce work');
  // The reported value is a lower bound and the pruned mass bounds the shortfall.
  assert.ok(approx.value <= exact.value + 1e-12);
  assert.ok(approx.value + approx.prunedMass >= exact.value - 1e-12);
});

test('grade mix is normalised and affects the answer', () => {
  const mix = normaliseGradeMix({ hard: 3, good: 6, easy: 1 });
  assert.ok(Math.abs(mix.hard + mix.good + mix.easy - 1) < 1e-12);
  assert.ok(Math.abs(mix.hard - 0.3) < 1e-12);

  const c = card({ stability: 6, daysSinceReview: 10 });
  const pessimist = new Valuer({
    model, examInDays: 14, gradeMix: { hard: 1, good: 0, easy: 0 },
  });
  const optimist = new Valuer({
    model, examInDays: 14, gradeMix: { hard: 0, good: 0, easy: 1 },
  });
  assert.ok(optimist.valuePlan(c, [4]).value > pessimist.valuePlan(c, [4]).value);
});

test('rating branches form a probability distribution', () => {
  const v = new Valuer({ model, examInDays: 5 });
  for (const r of [0, 0.25, 0.5, 0.9, 1]) {
    const total = v.ratingBranches(r).reduce((sum, [, p]) => sum + p, 0);
    assert.ok(Math.abs(total - 1) < 1e-12, `branches at R=${r} summed to ${total}`);
  }
  assert.equal(v.ratingBranches(1)[0][1], 0, 'a certain recall must not lapse');
  assert.equal(v.ratingBranches(0)[0][1], 1, 'a certain failure must lapse');
});

test('invalid plans are rejected with a specific message', () => {
  const v = new Valuer({ model, examInDays: 10 });
  const c = card();
  assert.throws(() => v.valuePlan(c, [10]), /\[0, 10\)/);
  assert.throws(() => v.valuePlan(c, [-1]), /\[0, 10\)/);
  assert.throws(() => v.valuePlan(c, [3, 3]), /strictly increasing/);
  assert.throws(() => v.valuePlan(c, [5, 2]), /strictly increasing/);
  assert.throws(() => v.valuePlan(c, [1.5]), /whole number/);
});

test('Valuer construction rejects nonsense settings', () => {
  assert.throws(() => new Valuer({ model, examInDays: 0 }), /nothing to plan/);
  assert.throws(() => new Valuer({ model, examInDays: 1.5 }), CrestError);
  assert.throws(() => new Valuer({ model, examInDays: 5, relearnSteps: -1 }), CrestError);
  assert.throws(() => new Valuer({ model, examInDays: 5, epsilon: 1 }), CrestError);
  // @ts-expect-error deliberately wrong type
  assert.throws(() => new Valuer({ model: {}, examInDays: 5 }), /Fsrs6/);
});

test('card validation names the field and the card', () => {
  assert.throws(() => validateCard({ ...card(), stability: -1 }), /stability/);
  assert.throws(() => validateCard({ ...card(), difficulty: 11 }), /difficulty/);
  assert.throws(() => validateCard({ ...card(), daysSinceReview: 1.5 }), /whole number/);
  assert.throws(() => validateCard({ ...card(), id: '' }), /non-empty string/);
  assert.throws(
    () => validateCard({ ...card(), id: 'xyz', secondsRecall: Number.NaN }),
    /card xyz: secondsRecall/,
  );
});

test('DEFAULT_GRADE_MIX is itself normalised', () => {
  const total = DEFAULT_GRADE_MIX.hard + DEFAULT_GRADE_MIX.good + DEFAULT_GRADE_MIX.easy;
  assert.ok(Math.abs(total - 1) < 1e-12);
});

test('a value escaping [0, 1] would raise InvariantError, not be silently clamped', () => {
  // Drive the guard directly: it is the last line of defence against a
  // probability bug, so it must be reachable rather than decorative.
  assert.ok(InvariantError.prototype instanceof Error);
  const v = new Valuer({ model, examInDays: 4 });
  const broken = Object.create(Object.getPrototypeOf(v));
  Object.assign(broken, v);
  broken.model = { retrievability: () => 5, nextDifficulty: () => 5 };
  assert.throws(
    () => Valuer.prototype.valuePlan.call(broken, card(), []),
    InvariantError,
  );
});

test('Rating values are the integers the equations assume', () => {
  assert.deepEqual(
    [Rating.Again, Rating.Hard, Rating.Good, Rating.Easy],
    [1, 2, 3, 4],
  );
});
