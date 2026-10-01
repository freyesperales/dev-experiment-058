// @ts-check
/**
 * @file CSV parsing, collection loading, the synthetic generator and the CLI's
 * argument parser. Unglamorous, and the place a real user's first five minutes
 * actually go wrong.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, parseCsvRows, toCsv } from '../src/csv.mjs';
import { loadCollection } from '../src/collection.mjs';
import { synthesiseCollection, collectionToCsv } from '../src/synth.mjs';
import { parseArgs } from '../src/cli.mjs';
import { addDays, weekdayOf } from '../src/viewmodel.mjs';
import { makeRng } from '../src/simulate.mjs';
import { CrestError } from '../src/errors.mjs';

test('CSV: quoted fields, embedded commas, newlines and doubled quotes', () => {
  const rows = parseCsvRows('a,b\n"x,1","he said ""hi"""\n"multi\nline",z\n');
  assert.deepEqual(rows, [
    ['a', 'b'],
    ['x,1', 'he said "hi"'],
    ['multi\nline', 'z'],
  ]);
});

test('CSV: CRLF, a BOM, blank lines and comments are all handled', () => {
  const text = '﻿a,b\r\n# a comment\r\n\r\n1,2\r\n';
  const { header, records } = parseCsv(text);
  assert.deepEqual(header, ['a', 'b']);
  assert.deepEqual(records, [{ a: '1', b: '2' }]);
});

test('CSV: a row with the wrong field count is an error naming the row', () => {
  assert.throws(() => parseCsv('a,b\n1,2\n3\n'), /data row 2 has 1 field\(s\) but the header declares 2/);
});

test('CSV: an unterminated quote reports where the quote opened', () => {
  assert.throws(() => parseCsvRows('a,b\n"oops,2\n3,4\n'), /opened on line 2/);
});

test('CSV: duplicate and empty header names are rejected', () => {
  assert.throws(() => parseCsv('a,a\n1,2\n'), /repeats the column "a"/);
  assert.throws(() => parseCsv('a,\n1,2\n'), /empty column name/);
  assert.throws(() => parseCsv(''), /no header row/);
});

test('CSV: toCsv quotes only what needs quoting, and round-trips', () => {
  const rows = [
    ['id', 'label'],
    ['1', 'plain'],
    ['2', 'has,comma'],
    ['3', 'has"quote'],
    ['4', 'has\nnewline'],
  ];
  const text = toCsv(rows);
  assert.ok(text.includes('1,plain\n'), 'a plain field was quoted unnecessarily');
  assert.deepEqual(parseCsvRows(text), rows);
});

test('a minimal collection loads', () => {
  const { cards } = loadCollection(
    'card_id,stability,difficulty,days_since_review\nx,10,5,3\ny,2.5,8.25,40\n',
  );
  assert.equal(cards.length, 2);
  assert.deepEqual(
    { ...cards[0], label: undefined },
    { id: 'x', stability: 10, difficulty: 5, daysSinceReview: 3, secondsRecall: 12, secondsLapse: 30, label: undefined },
  );
  assert.equal(cards[1].difficulty, 8.25);
});

test('column aliases are accepted', () => {
  const { cards } = loadCollection('cid,s,d,elapsed_days,avg_seconds,front\nq,7,4,9,20,Hello\n');
  assert.equal(cards[0].id, 'q');
  assert.equal(cards[0].stability, 7);
  assert.equal(cards[0].difficulty, 4);
  assert.equal(cards[0].daysSinceReview, 9);
  assert.equal(cards[0].secondsRecall, 20);
  assert.equal(cards[0].label, 'Hello');
  // No explicit lapse cost: derived from the recall cost rather than defaulted.
  assert.equal(cards[0].secondsLapse, 50);
});

test("Anki's 0-1 difficulty scale is detected and remapped", () => {
  const text = 'card_id,stability,difficulty,days_since_review\na,10,0.0,3\nb,20,0.5,4\nc,30,1.0,5\n';
  const result = loadCollection(text);
  assert.equal(result.difficultyScale, 'anki');
  assert.ok(result.scaleWasDetected);
  assert.equal(result.cards[0].difficulty, 1);
  assert.equal(result.cards[1].difficulty, 5.5);
  assert.equal(result.cards[2].difficulty, 10);
  assert.ok(result.notes.some((n) => /Anki/.test(n)), 'the remap was not reported');
});

test('a genuine FSRS-scale collection is not mistaken for the Anki scale', () => {
  const text = 'card_id,stability,difficulty,days_since_review\na,10,1,3\nb,20,1,4\n';
  // Every value is exactly 1.0, which is legal on both scales. The detector
  // requires at least one value strictly below 1 before remapping, so this stays
  // on the FSRS scale rather than being silently turned into all-ones anyway.
  const result = loadCollection(text);
  assert.equal(result.difficultyScale, 'fsrs');
  assert.equal(result.cards[0].difficulty, 1);
});

test('forcing the Anki scale remaps even when auto-detection would not', () => {
  // All values above 1, so auto-detection would read them as FSRS units. Forcing
  // `anki` must still remap -- and here that pushes them out of range, which is
  // the loud failure a silent remap would have hidden.
  const text = 'card_id,stability,difficulty,days_since_review\na,10,4,3\n';
  assert.equal(loadCollection(text).difficultyScale, 'fsrs');
  assert.throws(
    () => loadCollection(text, { difficultyScale: 'anki' }),
    /difficulty = 37 is outside the valid range \[1, 10\]/,
  );
});

test('out-of-range values on a forced scale are rejected, not clamped', () => {
  assert.throws(
    () => loadCollection('card_id,stability,difficulty,days_since_review\na,10,0.5,3\n', {
      difficultyScale: 'fsrs',
    }),
    /difficulty = 0.5 is outside the valid range \[1, 10\]/,
  );
});

test('last_review is converted to elapsed days against a fixed today', () => {
  const { cards } = loadCollection(
    'card_id,stability,difficulty,last_review\na,10,5,2026-09-20\nb,10,5,2026-10-01\n',
    { today: '2026-10-01' },
  );
  assert.equal(cards[0].daysSinceReview, 11);
  assert.equal(cards[1].daysSinceReview, 0);
});

test('a future last_review clamps to zero rather than going negative', () => {
  const { cards } = loadCollection(
    'card_id,stability,difficulty,last_review\na,10,5,2026-12-01\n',
    { today: '2026-10-01' },
  );
  assert.equal(cards[0].daysSinceReview, 0);
});

test('missing required columns produce an actionable error', () => {
  assert.throws(
    () => loadCollection('card_id,stability\na,10\n'),
    /must have a stability column and a difficulty column/,
  );
  assert.throws(
    () => loadCollection('card_id,stability,difficulty\na,10,5\n'),
    /days_since_review or last_review/,
  );
});

test('duplicate ids and unparseable numbers are rejected by row', () => {
  assert.throws(
    () => loadCollection('card_id,stability,difficulty,days_since_review\na,10,5,1\na,10,5,2\n'),
    /data row 2: duplicate card id "a"/,
  );
  assert.throws(
    () => loadCollection('card_id,stability,difficulty,days_since_review\na,lots,5,1\n'),
    /data row 1: stability = "lots" is not a number/,
  );
  assert.throws(
    () => loadCollection('card_id,stability,difficulty,days_since_review\na,10,5,\n'),
    /data row 1: days_since_review is empty/,
  );
});

test('an id-less CSV gets generated ids', () => {
  const { cards } = loadCollection('stability,difficulty,days_since_review\n10,5,1\n20,6,2\n');
  assert.deepEqual(cards.map((c) => c.id), ['card-1', 'card-2']);
});

test('the synthetic generator is reproducible and spans the interesting range', () => {
  const a = synthesiseCollection({ count: 200, seed: 99 });
  const b = synthesiseCollection({ count: 200, seed: 99 });
  assert.deepEqual(a, b, 'same seed gave a different collection');
  const c = synthesiseCollection({ count: 200, seed: 100 });
  assert.notDeepEqual(a, c, 'different seeds gave the same collection');

  for (const card of a) {
    assert.ok(card.stability > 0 && card.stability <= 1500);
    assert.ok(card.difficulty >= 1 && card.difficulty <= 10);
    assert.ok(Number.isInteger(card.daysSinceReview) && card.daysSinceReview >= 0);
    assert.ok(card.secondsRecall >= 3 && card.secondsRecall <= 60);
    assert.ok(card.secondsLapse > card.secondsRecall);
  }
  const stabilities = a.map((x) => x.stability).sort((x, y) => x - y);
  assert.ok(stabilities[0] < 5, 'no weak cards were generated');
  assert.ok(stabilities[stabilities.length - 1] > 100, 'no mature cards were generated');
});

test('a synthetic collection survives its own CSV round-trip', () => {
  const cards = synthesiseCollection({ count: 40, seed: 8 });
  const { cards: reloaded, difficultyScale } = loadCollection(collectionToCsv(cards));
  assert.equal(difficultyScale, 'fsrs');
  assert.equal(reloaded.length, cards.length);
  for (let i = 0; i < cards.length; i += 1) {
    assert.equal(reloaded[i].id, cards[i].id);
    assert.ok(Math.abs(reloaded[i].stability - cards[i].stability) < 1e-9);
    assert.ok(Math.abs(reloaded[i].difficulty - cards[i].difficulty) < 1e-9);
    assert.equal(reloaded[i].daysSinceReview, cards[i].daysSinceReview);
  }
});

test('synth rejects an impossible count', () => {
  assert.throws(() => synthesiseCollection({ count: 0 }), CrestError);
  assert.throws(() => synthesiseCollection({ count: 1.5 }), CrestError);
});

test('argument parsing handles both --flag value and --flag=value', () => {
  const { command, flags } = parseArgs(['plan', '--cards', 'a.csv', '--exam-in=14', '--quiet']);
  assert.equal(command, 'plan');
  assert.equal(flags.get('cards'), 'a.csv');
  assert.equal(flags.get('exam-in'), '14');
  assert.equal(flags.get('quiet'), true);
});

test('argument parsing accepts negative numbers as values', () => {
  const { flags } = parseArgs(['demo', '--seed', '-5']);
  assert.equal(flags.get('seed'), '-5');
});

test('--json works as a bare flag and with a value', () => {
  assert.equal(parseArgs(['demo', '--json']).flags.get('json'), true);
  assert.equal(parseArgs(['demo', '--json', 'out.json']).flags.get('json'), 'out.json');
  // Followed by another flag, it stays boolean rather than swallowing it.
  const { flags } = parseArgs(['demo', '--json', '--quiet']);
  assert.equal(flags.get('json'), true);
  assert.equal(flags.get('quiet'), true);
});

test('a flag that needs a value and has none is an error', () => {
  assert.throws(() => parseArgs(['plan', '--cards']), /--cards needs a value/);
  assert.throws(() => parseArgs(['plan', '--exam-in', '--quiet']), /--exam-in needs a value/);
});

test('two subcommands are rejected', () => {
  assert.throws(() => parseArgs(['plan', 'demo']), /unexpected argument "demo"/);
});

test('date helpers work across month and year boundaries in UTC', () => {
  assert.equal(addDays('2026-10-01', 0), '2026-10-01');
  assert.equal(addDays('2026-10-01', 31), '2026-11-01');
  assert.equal(addDays('2026-12-28', 10), '2027-01-07');
  assert.equal(addDays('2028-02-28', 1), '2028-02-29');
  assert.equal(weekdayOf('2026-10-01'), 'Thu');
  assert.throws(() => addDays('not-a-date', 1), /ISO date/);
});

test('the RNG is deterministic and stays in range', () => {
  const a = makeRng(7);
  const b = makeRng(7);
  for (let i = 0; i < 1000; i += 1) {
    const x = a();
    assert.equal(x, b());
    assert.ok(x >= 0 && x < 1);
  }
  assert.notEqual(makeRng(7)(), makeRng(8)());
  assert.throws(() => makeRng(1.5), CrestError);
});
