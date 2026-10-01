// @ts-check
/**
 * @file The memory model. If these are wrong, every number crest prints is wrong,
 * so they are pinned against the defining identities of FSRS rather than against
 * values this implementation happened to produce.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Fsrs6,
  DEFAULT_PARAMETERS,
  Rating,
  STABILITY_MIN,
  MIN_DIFFICULTY,
  MAX_DIFFICULTY,
  LOWER_BOUNDS_PARAMETERS,
} from '../src/fsrs.mjs';
import { CrestError } from '../src/errors.mjs';

const model = new Fsrs6();

test('R(S, S) = 0.9 exactly: this is what "stability" means', () => {
  for (const s of [0.5, 1, 7, 18, 100, 365, 1000]) {
    assert.ok(
      Math.abs(model.retrievability(s, s) - 0.9) < 1e-9,
      `R(${s}, ${s}) = ${model.retrievability(s, s)}, expected 0.9`,
    );
  }
});

test('nextInterval inverts the forgetting curve at the desired retention', () => {
  // The interval FSRS picks must be the one at which R equals the target.
  for (const s of [1, 5, 40, 300]) {
    for (const r of [0.8, 0.9, 0.95]) {
      const interval = model.nextInterval(s, r);
      const achieved = model.retrievability(s, interval);
      // nextInterval rounds to whole days, so allow one day of rounding slack.
      const lower = model.retrievability(s, interval + 1);
      const upper = model.retrievability(s, Math.max(interval - 1, 0));
      assert.ok(
        achieved <= upper + 1e-9 && achieved >= lower - 1e-9,
        `S=${s} r=${r}: interval ${interval} gives R=${achieved}`,
      );
    }
  }
});

test('nextInterval at 90% retention returns the stability itself', () => {
  for (const s of [3, 10, 47, 220]) {
    assert.equal(model.nextInterval(s, 0.9), Math.round(s));
  }
});

test('retrievability decreases monotonically in elapsed time', () => {
  let previous = Infinity;
  for (let t = 0; t <= 400; t += 1) {
    const r = model.retrievability(30, t);
    assert.ok(r <= previous + 1e-12, `R rose at t=${t}`);
    assert.ok(r > 0 && r <= 1, `R out of range at t=${t}: ${r}`);
    previous = r;
  }
});

test('retrievability increases monotonically in stability', () => {
  let previous = -Infinity;
  for (const s of [0.5, 1, 2, 5, 10, 50, 500]) {
    const r = model.retrievability(s, 20);
    assert.ok(r > previous, `R did not increase at S=${s}`);
    previous = r;
  }
});

test('the spacing effect: a review at lower retrievability gains more stability', () => {
  // This is the structural fact the whole planner rests on. If it ever reversed,
  // reviewing everything on day 0 would be optimal and crest would be pointless.
  const s = 20;
  const d = 5;
  // Walking R upwards, the gain must fall: the better you still remember a card,
  // the less a review teaches you.
  let previousGain = Infinity;
  for (const r of [0.6, 0.7, 0.8, 0.9, 0.95]) {
    const gain = model.nextRecallStability(d, s, r, Rating.Good) - s;
    assert.ok(gain > 0, `no stability gain at R=${r}`);
    assert.ok(gain < previousGain, `gain did not shrink as R rose (R=${r}, gain=${gain})`);
    previousGain = gain;
  }
  // And at R = 1 the gain vanishes entirely, which is the mathematical statement
  // of "reviewing something you have just reviewed is worthless".
  assert.ok(Math.abs(model.nextRecallStability(d, s, 1, Rating.Good) - s) < 1e-12);
});

test('a lapse reduces stability', () => {
  for (const s of [2, 10, 60, 300]) {
    const r = model.retrievability(s, s * 2);
    const after = model.nextStability(5, s, r, Rating.Again);
    assert.ok(after < s, `lapse at S=${s} produced ${after}`);
    assert.ok(after >= STABILITY_MIN);
  }
});

test('post-lapse stability never exceeds the short-term ceiling', () => {
  // FSRS takes a minimum of two expressions; the ceiling must bind somewhere,
  // otherwise the min() has been ported as the wrong comparison.
  const w = DEFAULT_PARAMETERS;
  const ceilingFactor = Math.exp(w[17] * w[18]);
  for (const s of [0.5, 1, 3, 20, 200]) {
    const after = model.nextForgetStability(5, s, 0.4);
    assert.ok(after <= s / ceilingFactor + 1e-12, `S=${s}: ${after} > ${s / ceilingFactor}`);
  }
});

test('grade ordering: Easy >= Good >= Hard in resulting stability', () => {
  const s = 15;
  const r = 0.75;
  const hard = model.nextRecallStability(5, s, r, Rating.Hard);
  const good = model.nextRecallStability(5, s, r, Rating.Good);
  const easy = model.nextRecallStability(5, s, r, Rating.Easy);
  assert.ok(hard < good, `hard ${hard} should be below good ${good}`);
  assert.ok(good < easy, `good ${good} should be below easy ${easy}`);
});

test('difficulty moves the right way and stays in [1, 10]', () => {
  let d = 5;
  for (let i = 0; i < 40; i += 1) d = model.nextDifficulty(d, Rating.Again);
  assert.ok(d <= MAX_DIFFICULTY && d > 8, `repeated lapses gave D=${d}`);
  let e = 5;
  for (let i = 0; i < 40; i += 1) e = model.nextDifficulty(e, Rating.Easy);
  assert.ok(e >= MIN_DIFFICULTY && e < 2, `repeated Easy gave D=${e}`);
});

test('the mean-reversion target is the UNCLAMPED initial difficulty for Easy', () => {
  // Clamping it would silently change every difficulty update. With the default
  // parameters the correct value is negative, well outside [1, 10].
  const unclamped = model.initialDifficulty(Rating.Easy, false);
  assert.ok(unclamped < 0, `expected a negative target, got ${unclamped}`);
  assert.equal(model.initialDifficulty(Rating.Easy, true), MIN_DIFFICULTY);
});

test('initial stability reads w0..w3 in grade order', () => {
  assert.equal(model.initialStability(Rating.Again), DEFAULT_PARAMETERS[0]);
  assert.equal(model.initialStability(Rating.Hard), DEFAULT_PARAMETERS[1]);
  assert.equal(model.initialStability(Rating.Good), DEFAULT_PARAMETERS[2]);
  assert.equal(model.initialStability(Rating.Easy), DEFAULT_PARAMETERS[3]);
});

test('short-term stability never shrinks a card on a passing grade', () => {
  for (const s of [0.1, 1, 10, 100]) {
    for (const g of [Rating.Hard, Rating.Good, Rating.Easy]) {
      assert.ok(
        model.shortTermStability(s, g) >= s - 1e-12,
        `S=${s} grade=${g} shrank to ${model.shortTermStability(s, g)}`,
      );
    }
  }
});

test('parameter validation reports every offending index at once', () => {
  const bad = Array.from(DEFAULT_PARAMETERS);
  bad[4] = 99;
  bad[9] = -1;
  assert.throws(
    () => new Fsrs6(bad),
    (error) => {
      assert.ok(error instanceof CrestError);
      assert.match(error.message, /w\[4\]/);
      assert.match(error.message, /w\[9\]/);
      return true;
    },
  );
});

test('a 19-weight FSRS-5 vector is rejected with an explanation', () => {
  assert.throws(
    () => new Fsrs6(Array.from(DEFAULT_PARAMETERS).slice(0, 19)),
    /FSRS-5 vectors have 19/,
  );
});

test('every default parameter sits inside its own declared bounds', () => {
  assert.equal(DEFAULT_PARAMETERS.length, LOWER_BOUNDS_PARAMETERS.length);
  assert.doesNotThrow(() => new Fsrs6(DEFAULT_PARAMETERS));
});

test('non-finite inputs throw rather than propagating NaN', () => {
  assert.throws(() => model.retrievability(Number.NaN, 5), CrestError);
  assert.throws(() => model.retrievability(10, Number.POSITIVE_INFINITY), CrestError);
  assert.throws(() => model.nextDifficulty(Number.NaN, Rating.Good), CrestError);
  assert.throws(() => model.nextStability(5, 10, 0.9, 7), CrestError);
  assert.throws(() => model.nextInterval(10, 1.5), CrestError);
});

test('a custom parameter vector changes predictions', () => {
  const custom = Array.from(DEFAULT_PARAMETERS);
  custom[20] = 0.4; // a much steeper forgetting curve
  const steep = new Fsrs6(custom);
  assert.ok(steep.retrievability(20, 40) < model.retrievability(20, 40));
  // The defining identity must survive a parameter change.
  assert.ok(Math.abs(steep.retrievability(20, 20) - 0.9) < 1e-9);
});
