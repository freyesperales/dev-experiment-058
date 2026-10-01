// @ts-check
/**
 * @file The planner and its optimality certificate.
 *
 * The claim that needs independent checking is the certificate. A gap reported by
 * the same code that produced the plan proves nothing, so the tests here bracket
 * the brute-force optimum: on every small instance, OPT must satisfy
 * primal <= OPT <= dual. If the dual derivation were wrong, OPT would escape above
 * it; if the feasibility check were wrong, the primal would escape above OPT.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { Fsrs6 } from '../src/fsrs.mjs';
import { Valuer } from '../src/value.mjs';
import { enumeratePlans, countPlans, buildCardPlanTable, MAX_PLANS } from '../src/plans.mjs';
import { solve } from '../src/solver.mjs';
import { solveExact } from '../src/exact.mjs';
import { synthesiseCollection } from '../src/synth.mjs';
import { expandBudget } from '../src/plan.mjs';
import { CrestError } from '../src/errors.mjs';

const model = new Fsrs6();

/**
 * @param {string} id
 * @param {Partial<import('../src/value.mjs').Card>} [o]
 * @returns {import('../src/value.mjs').Card}
 */
function card(id, o = {}) {
  return {
    id,
    stability: 10,
    difficulty: 5,
    daysSinceReview: 15,
    secondsRecall: 12,
    secondsLapse: 30,
    ...o,
  };
}

test('plan enumeration matches its closed-form count and starts with the empty plan', () => {
  for (const days of [1, 3, 7, 12]) {
    for (const k of [0, 1, 2, 3]) {
      const plans = enumeratePlans(days, k);
      assert.equal(plans.length, countPlans(days, Math.min(k, days)));
      assert.deepEqual(plans[0], []);
      // Strictly increasing, within range, no duplicates.
      const seen = new Set();
      for (const plan of plans) {
        assert.ok(plan.length <= k);
        for (let i = 1; i < plan.length; i += 1) assert.ok(plan[i] > plan[i - 1]);
        for (const d of plan) assert.ok(d >= 0 && d < days);
        const key = plan.join(',');
        assert.ok(!seen.has(key), `duplicate plan ${key}`);
        seen.add(key);
      }
    }
  }
});

test('countPlans is sum of binomials', () => {
  assert.equal(countPlans(5, 0), 1);
  assert.equal(countPlans(5, 1), 6);
  assert.equal(countPlans(5, 2), 16);
  assert.equal(countPlans(5, 3), 26);
  assert.equal(countPlans(30, 2), 1 + 30 + 435);
  assert.equal(countPlans(30, 3), 1 + 30 + 435 + 4060);
});

test('an oversized plan family is refused with a usable hint, not attempted', () => {
  assert.throws(
    () => enumeratePlans(400, 4),
    (error) => {
      assert.ok(error instanceof CrestError);
      assert.match(error.message, /ceiling/);
      assert.match(String(error.hint), /max-reviews/);
      return true;
    },
  );
  assert.ok(countPlans(400, 4) > MAX_PLANS);
});

test('the brute-force optimum lies inside [primal, dual] on small instances', () => {
  const examInDays = 6;
  const plans = enumeratePlans(examInDays, 2);
  const valuer = new Valuer({ model, examInDays });

  // Several instance shapes, including one where the budget is the binding
  // constraint and one where it is not.
  const instances = [
    {
      name: 'tight budget, mixed cards',
      cards: [
        card('a', { stability: 2, daysSinceReview: 40 }),
        card('b', { stability: 8, daysSinceReview: 20 }),
        card('c', { stability: 40, daysSinceReview: 10 }),
        card('d', { stability: 1, daysSinceReview: 90, secondsRecall: 25, secondsLapse: 60 }),
      ],
      budgetMinutes: 0.5,
    },
    {
      name: 'generous budget',
      cards: [
        card('a', { stability: 3, daysSinceReview: 30 }),
        card('b', { stability: 6, daysSinceReview: 25 }),
        card('c', { stability: 15, daysSinceReview: 5 }),
      ],
      budgetMinutes: 30,
    },
    {
      name: 'one day has no time at all',
      cards: [
        card('a', { stability: 2, daysSinceReview: 50 }),
        card('b', { stability: 4, daysSinceReview: 30 }),
        card('c', { stability: 9, daysSinceReview: 18 }),
      ],
      budgetMinutes: [1, 0, 1, 0, 1, 0],
    },
  ];

  for (const instance of instances) {
    const budgetsSeconds = expandBudget(instance.budgetMinutes, examInDays);
    // safeThreshold 1 so that nothing is fixed outside the optimisation and the
    // two solvers are answering exactly the same question.
    const result = solve({
      cards: instance.cards,
      valuer,
      plans,
      budgetsSeconds,
      safeThreshold: 1,
      iterations: 80,
    });
    const exact = solveExact({ cards: instance.cards, valuer, plans, budgetsSeconds });

    assert.ok(
      result.primalValue <= exact.value + 1e-9,
      `${instance.name}: primal ${result.primalValue} exceeded the true optimum ${exact.value}`,
    );
    assert.ok(
      result.dualBound >= exact.value - 1e-9,
      `${instance.name}: dual ${result.dualBound} fell below the true optimum ${exact.value}`,
    );
    assert.ok(result.gap >= 0 && result.gap <= 1, `${instance.name}: gap ${result.gap}`);
  }
});

test('on small instances the heuristic lands on or next to the optimum', () => {
  // Bracketing is the guarantee; closing the gap is the quality claim. The repair
  // is a heuristic and makes no promise of exactness, so this asserts a tight
  // tolerance rather than equality -- enough to catch a repair that has stopped
  // working, without asserting something the algorithm does not offer.
  const examInDays = 5;
  const plans = enumeratePlans(examInDays, 2);
  const valuer = new Valuer({ model, examInDays });
  const cards = [
    card('a', { stability: 2, daysSinceReview: 45 }),
    card('b', { stability: 7, daysSinceReview: 22 }),
    card('c', { stability: 20, daysSinceReview: 12 }),
  ];
  const budgetsSeconds = expandBudget(0.6, examInDays);
  const result = solve({ cards, valuer, plans, budgetsSeconds, safeThreshold: 1, iterations: 120 });
  const exact = solveExact({ cards, valuer, plans, budgetsSeconds });
  assert.ok(result.primalValue <= exact.value + 1e-9);
  assert.ok(
    result.primalValue > exact.value - 0.01,
    `primal ${result.primalValue} fell well short of the optimum ${exact.value}`,
  );
});

test('the returned plan never exceeds any daily budget', () => {
  const examInDays = 10;
  const plans = enumeratePlans(examInDays, 2);
  const valuer = new Valuer({ model, examInDays });
  const cards = synthesiseCollection({ count: 60, seed: 7 });
  const budgetsSeconds = expandBudget([3, 1, 0, 5, 2, 2, 8, 1, 1, 4], examInDays);
  const result = solve({ cards, valuer, plans, budgetsSeconds, safeThreshold: 1 });

  const used = new Array(examInDays).fill(0);
  for (const a of result.assignments) {
    for (let j = 0; j < a.planDays.length; j += 1) used[a.planDays[j]] += a.dayCosts[j];
  }
  for (let d = 0; d < examInDays; d += 1) {
    assert.ok(
      used[d] <= budgetsSeconds[d] + 1e-6,
      `day ${d}: used ${used[d]}s against a budget of ${budgetsSeconds[d]}s`,
    );
    assert.ok(Math.abs(used[d] - result.usedSeconds[d]) < 1e-6, `day ${d} usage disagreed`);
  }
  // A day with no budget must receive no cards at all.
  assert.equal(used[2], 0);
});

test('every card gets exactly one plan, and skipped cards get none', () => {
  const examInDays = 8;
  const plans = enumeratePlans(examInDays, 2);
  const valuer = new Valuer({ model, examInDays });
  const cards = synthesiseCollection({ count: 50, seed: 3 });
  const result = solve({ cards, valuer, plans, budgetsSeconds: expandBudget(10, examInDays) });

  const ids = new Set();
  for (const a of [...result.assignments, ...result.skipped]) {
    assert.ok(!ids.has(a.cardId), `card ${a.cardId} appeared twice`);
    ids.add(a.cardId);
  }
  assert.equal(ids.size, cards.length);
  for (const s of result.skipped) assert.deepEqual(s.planDays, []);
});

test('a plan is never worse than doing nothing', () => {
  const examInDays = 12;
  const plans = enumeratePlans(examInDays, 2);
  const valuer = new Valuer({ model, examInDays });
  const cards = synthesiseCollection({ count: 80, seed: 11 });
  for (const minutes of [0, 5, 30, 240]) {
    const result = solve({
      cards, valuer, plans, budgetsSeconds: expandBudget(minutes, examInDays),
    });
    assert.ok(
      result.primalValue >= result.baselineValue - 1e-9,
      `budget ${minutes}: planned ${result.primalValue} below baseline ${result.baselineValue}`,
    );
    if (minutes === 0) {
      assert.ok(Math.abs(result.primalValue - result.baselineValue) < 1e-9);
      assert.equal(result.assignments.filter((a) => a.planDays.length > 0).length, 0);
    }
  }
});

test('more budget never produces less expected recall', () => {
  const examInDays = 10;
  const plans = enumeratePlans(examInDays, 2);
  const valuer = new Valuer({ model, examInDays });
  const cards = synthesiseCollection({ count: 70, seed: 5 });
  let previous = -Infinity;
  for (const minutes of [0, 2, 5, 10, 20, 60]) {
    const result = solve({
      cards, valuer, plans, budgetsSeconds: expandBudget(minutes, examInDays),
      iterations: 40,
    });
    // The repair is a heuristic, so allow a whisker of non-monotonicity rather
    // than asserting something the algorithm does not promise.
    assert.ok(
      result.primalValue >= previous - 0.05,
      `budget ${minutes} scored ${result.primalValue}, below ${previous} at a smaller budget`,
    );
    previous = Math.max(previous, result.primalValue);
  }
});

test('the shadow price concentrates on the days nearest the exam', () => {
  // The economic signature of the monotonicity result: late days are the scarce
  // resource, so that is where lambda should sit.
  const examInDays = 12;
  const plans = enumeratePlans(examInDays, 2);
  const valuer = new Valuer({ model, examInDays });
  const cards = synthesiseCollection({ count: 150, seed: 21 });
  const result = solve({
    cards, valuer, plans,
    budgetsSeconds: expandBudget(5, examInDays),
    safeThreshold: 1,
    iterations: 100,
  });
  const firstHalf = result.lambda.slice(0, 6).reduce((a, b) => a + b, 0);
  const lastHalf = result.lambda.slice(6).reduce((a, b) => a + b, 0);
  assert.ok(lastHalf > 0, 'no day acquired a positive shadow price');
  assert.ok(
    lastHalf > firstHalf,
    `shadow price mass sat early (first half ${firstHalf}, last half ${lastHalf})`,
  );
});

test('an all-safe collection plans nothing and reports a zero gap', () => {
  const examInDays = 5;
  const plans = enumeratePlans(examInDays, 2);
  const valuer = new Valuer({ model, examInDays });
  // Stability far above the horizon, reviewed today: recall at the exam is ~1.
  const cards = [card('a', { stability: 4000, daysSinceReview: 0 })];
  const result = solve({
    cards, valuer, plans, budgetsSeconds: expandBudget(60, examInDays), safeThreshold: 0.98,
  });
  assert.equal(result.assignments.length, 0);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.gap, 0);
  assert.ok(Math.abs(result.primalValue - result.dualBound) < 1e-12);
});

test('solve rejects malformed inputs', () => {
  const examInDays = 4;
  const plans = enumeratePlans(examInDays, 1);
  const valuer = new Valuer({ model, examInDays });
  assert.throws(
    () => solve({ cards: [], valuer, plans, budgetsSeconds: [0, 0, 0, 0] }),
    /no cards/,
  );
  assert.throws(
    () => solve({ cards: [card('a')], valuer, plans, budgetsSeconds: [1, 2] }),
    /expected 4 daily budgets/,
  );
  assert.throws(
    () => solve({ cards: [card('a')], valuer, plans, budgetsSeconds: [1, 2, -3, 4] }),
    />= 0/,
  );
  assert.throws(
    () => solve({
      cards: [card('a')], valuer, plans, budgetsSeconds: [1, 1, 1, 1], safeThreshold: 0,
    }),
    /safeThreshold/,
  );
});

test('buildCardPlanTable lines costs up with the plan days', () => {
  const examInDays = 6;
  const plans = enumeratePlans(examInDays, 2);
  const valuer = new Valuer({ model, examInDays });
  const c = card('a', { stability: 5, daysSinceReview: 20 });
  const table = buildCardPlanTable(valuer, c, plans);
  assert.equal(table.values.length, plans.length);
  assert.equal(table.baseline, valuer.baselineValue(c));
  assert.equal(table.stride, 2);
  for (let p = 0; p < plans.length; p += 1) {
    const direct = valuer.valuePlan(c, plans[p]);
    assert.ok(Math.abs(table.values[p] - direct.value) < 1e-15);
    for (let j = 0; j < plans[p].length; j += 1) {
      assert.ok(Math.abs(table.dayCosts[p * table.stride + j] - direct.dayCosts[j]) < 1e-15);
    }
  }
});

test('expandBudget repeats a short list to make a weekly rhythm', () => {
  assert.deepEqual(expandBudget(2, 3), [120, 120, 120]);
  assert.deepEqual(expandBudget([1, 2], 5), [60, 120, 60, 120, 60]);
  assert.throws(() => expandBudget([], 3), /at least one/);
  assert.throws(() => expandBudget([-1], 3), />= 0/);
  assert.throws(() => expandBudget([Number.NaN], 3), CrestError);
});

test('brute force refuses instances it cannot settle', () => {
  const plans = enumeratePlans(20, 2);
  const valuer = new Valuer({ model, examInDays: 20 });
  assert.throws(
    () => solveExact({
      cards: synthesiseCollection({ count: 40 }),
      valuer, plans,
      budgetsSeconds: expandBudget(10, 20),
    }),
    /verification on small instances only/,
  );
});
