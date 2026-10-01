// @ts-check
/**
 * @file The view model and the text report.
 *
 * The view model is also what the browser app renders, so covering it here is how
 * the app's logic gets tested without a browser: everything except the handful of
 * `document` calls in `app/ui.mjs` goes through these paths.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { planCollection } from '../src/plan.mjs';
import { renderReport, renderTable } from '../src/report.mjs';
import { synthesiseCollection } from '../src/synth.mjs';

/** A small instance that still exercises every branch of the report. */
function run(overrides = {}) {
  return planCollection({
    cards: synthesiseCollection({ count: 90, seed: 4 }),
    examInDays: 9,
    budgetMinutes: 6,
    startDate: '2026-10-01',
    trials: 300,
    seed: 2,
    iterations: 30,
    ...overrides,
  });
}

test('the view model accounts for every card exactly once', () => {
  const { viewModel } = run();
  const s = /** @type {any} */ (viewModel.summary);
  assert.equal(
    s.cardsSafe + s.cardsPlanned + s.cardsAbandoned,
    s.cards,
    'cards went missing between the solver and the report',
  );
  const ids = new Set([
    ...viewModel.perCard.map((c) => /** @type {any} */ (c).cardId),
    ...viewModel.abandoned.map((c) => /** @type {any} */ (c).cardId),
    ...viewModel.safe.map((c) => /** @type {any} */ (c).cardId),
  ]);
  assert.equal(ids.size, s.cards);
});

test('the daily table sums to the reported totals', () => {
  const { viewModel } = run();
  const s = /** @type {any} */ (viewModel.summary);
  const days = /** @type {any[]} */ (viewModel.days);
  assert.equal(days.length, s.examInDays);
  const minutes = days.reduce((a, d) => a + d.minutes, 0);
  const cardsScheduled = days.reduce((a, d) => a + d.cards, 0);
  assert.ok(Math.abs(minutes - s.plannedMinutes) < 1e-6);
  assert.equal(cardsScheduled, s.reviewsScheduled);
  for (const d of days) {
    assert.ok(d.minutes <= d.budgetMinutes + 1e-9, `day ${d.day} over budget in the report`);
    assert.ok(d.utilisation >= 0 && d.utilisation <= 1 + 1e-9);
  }
});

test('dates line up with the start date and the exam date', () => {
  const { viewModel } = run({ startDate: '2026-10-01', examInDays: 9 });
  const s = /** @type {any} */ (viewModel.summary);
  const days = /** @type {any[]} */ (viewModel.days);
  assert.equal(days[0].date, '2026-10-01');
  assert.equal(days[0].weekday, 'Thu');
  assert.equal(days[8].date, '2026-10-09');
  assert.equal(s.examDate, '2026-10-10');
  for (const c of /** @type {any[]} */ (viewModel.perCard)) {
    assert.equal(c.dates.length, c.days.length);
    for (let i = 0; i < c.days.length; i += 1) {
      assert.equal(c.dates[i], days[c.days[i]].date);
    }
  }
});

test('scheduled cards have a positive gain, abandoned cards have no days', () => {
  const { viewModel } = run();
  for (const c of /** @type {any[]} */ (viewModel.perCard)) {
    assert.ok(c.days.length > 0, 'a scheduled card had no review days');
    assert.ok(c.gain >= 0, `card ${c.cardId} was scheduled for a negative gain`);
    assert.ok(c.value >= c.baseline - 1e-12);
  }
  for (const c of /** @type {any[]} */ (viewModel.abandoned)) {
    assert.equal(c.days.length, 0);
  }
  // Sorted most valuable first, which is the order a student should work in.
  const gains = /** @type {any[]} */ (viewModel.perCard).map((c) => c.gain);
  for (let i = 1; i < gains.length; i += 1) assert.ok(gains[i] <= gains[i - 1] + 1e-12);
});

test('the reported bounds bracket the plan, and the plan beats doing nothing', () => {
  const { viewModel } = run();
  const r = /** @type {any} */ (viewModel.summary).expectedRecall;
  assert.ok(r.doNothing <= r.planned + 1e-9, 'the plan was worse than doing nothing');
  assert.ok(r.planned <= r.upperBound + 1e-9, 'the plan exceeded its own proven ceiling');
  assert.ok(r.upperBound <= /** @type {any} */ (viewModel.summary).cards + 1e-9);
});

test('the Monte-Carlo cross-check agrees with the exact plan value', () => {
  // Same assertion the CLI prints, asserted rather than merely displayed.
  const { viewModel } = run({ trials: 6000 });
  const r = /** @type {any} */ (viewModel.summary).expectedRecall;
  assert.ok(r.planSimulated !== null && r.planSimulatedStderr !== null);
  assert.ok(
    Math.abs(r.planSimulated - r.planned) < 4 * r.planSimulatedStderr + 1e-6,
    `simulated ${r.planSimulated} +/- ${r.planSimulatedStderr} vs exact ${r.planned}`,
  );
});

test('the Anki-policy baseline is computed and is a sane quantity', () => {
  // Deliberately NOT asserted to fall below `upperBound`. That bound covers the
  // declared plan family (at most --max-reviews reviews per card); the Anki policy
  // has no such cap and can review a weak card every day, so it is free to exceed
  // it. If it does, the honest response is to raise --max-reviews, not to widen
  // the claim.
  const { viewModel } = run({ trials: 2000 });
  const s = /** @type {any} */ (viewModel.summary);
  const r = s.expectedRecall;
  assert.ok(r.ankiPolicy !== null && Number.isFinite(r.ankiPolicy));
  assert.ok(r.ankiPolicy >= 0 && r.ankiPolicy <= s.cards + 1e-9);
  assert.ok(r.ankiPolicyStderr >= 0);
  assert.ok(
    r.ankiPolicy > r.doNothing,
    `studying what is due should beat studying nothing (${r.ankiPolicy} vs ${r.doNothing})`,
  );
  assert.ok(s.ankiPolicyMinutes !== null && s.ankiPolicyMinutes >= 0);
  assert.equal(s.gainOverAnkiPolicy, r.planned - r.ankiPolicy);
});

test('trials: 0 skips both simulations without breaking the report', () => {
  const { viewModel } = run({ trials: 0 });
  const r = /** @type {any} */ (viewModel.summary).expectedRecall;
  assert.equal(r.ankiPolicy, null);
  assert.equal(r.planSimulated, null);
  assert.ok(renderReport(viewModel).length > 0);
});

test('an extra hour is only ever recommended for a saturated day', () => {
  const { viewModel } = run();
  const s = /** @type {any} */ (viewModel.summary);
  if (s.bestDayForAnExtraHour !== null) {
    const day = /** @type {any[]} */ (viewModel.days)[s.bestDayForAnExtraHour.day];
    assert.ok(day.utilisation >= 0.995, 'recommended adding time to a day with slack');
    assert.ok(s.bestDayForAnExtraHour.extraCardsPerHour > 0);
    assert.equal(s.bestDayForAnExtraHour.date, day.date);
  }
  // With a budget far beyond what the collection can absorb, no day is saturated
  // and the recommendation must be absent rather than arbitrary.
  const generous = run({ budgetMinutes: 600 });
  assert.equal(/** @type {any} */ (generous.viewModel.summary).bestDayForAnExtraHour, null);
});

test('the report renders, mentions the exam date, and has no undefined holes', () => {
  const { viewModel } = run();
  const text = renderReport(viewModel, { maxCardRows: 5 });
  assert.ok(text.includes('2026-10-10'), 'the exam date is missing from the report');
  assert.ok(text.includes('EXPECTED RECALL ON EXAM DAY'));
  assert.ok(text.includes('DAILY PLAN'));
  assert.ok(text.includes('CARD DISPOSITION'));
  assert.ok(!/undefined|NaN|\[object/.test(text), `report contains a rendering hole:\n${text}`);
});

test('maxCardRows 0 shows every scheduled card', () => {
  const { viewModel } = run();
  const limited = renderReport(viewModel, { maxCardRows: 3 });
  const all = renderReport(viewModel, { maxCardRows: 0 });
  assert.ok(all.length > limited.length);
  assert.ok(all.includes(`${viewModel.perCard.length} of ${viewModel.perCard.length} shown`));
});

test('the view model is JSON-serialisable with no cycles or non-finite numbers', () => {
  const { viewModel } = run();
  const text = JSON.stringify(viewModel);
  assert.ok(text.length > 0);
  const walk = (/** @type {unknown} */ value, /** @type {string} */ path) => {
    if (typeof value === 'number') {
      assert.ok(Number.isFinite(value), `${path} is ${value}`);
    } else if (Array.isArray(value)) {
      value.forEach((v, i) => walk(v, `${path}[${i}]`));
    } else if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) walk(v, `${path}.${k}`);
    }
  };
  walk(JSON.parse(text), 'viewModel');
});

test('renderTable aligns columns and survives empty input', () => {
  const text = renderTable(['a', 'bb'], [['1', '2'], ['333', '4']], ['left', 'right']);
  const lines = text.split('\n');
  assert.equal(lines.length, 4);
  assert.equal(lines[1], '---  --');
  assert.ok(lines[2].startsWith('1 '));
  assert.equal(renderTable(['only'], []).split('\n').length, 2);
});

test('a one-day horizon works: the exam is tomorrow', () => {
  const { viewModel } = run({ examInDays: 1, budgetMinutes: 20 });
  const s = /** @type {any} */ (viewModel.summary);
  assert.equal(s.examInDays, 1);
  assert.equal(/** @type {any[]} */ (viewModel.days).length, 1);
  assert.equal(s.examDate, '2026-10-02');
  assert.ok(renderReport(viewModel).length > 0);
});

test('a single-card collection works', () => {
  const { viewModel } = run({
    cards: synthesiseCollection({ count: 1, seed: 1 }),
    examInDays: 5,
    budgetMinutes: 10,
  });
  assert.equal(/** @type {any} */ (viewModel.summary).cards, 1);
  assert.ok(renderReport(viewModel).length > 0);
});
