// @ts-check
/**
 * @file Text rendering of a view model.
 *
 * Plain ASCII tables, no colour codes unless stdout is a TTY, no box-drawing
 * characters: the output of this tool gets pasted into forum posts and study
 * notes, and it should survive that.
 */

/**
 * @param {number} value
 * @param {number} [digits]
 * @returns {string}
 */
function pct(value, digits = 1) {
  return `${(value * 100).toFixed(digits)}%`;
}

/**
 * @param {number} value
 * @param {number} [digits]
 * @returns {string}
 */
function num(value, digits = 1) {
  return value.toFixed(digits);
}

/**
 * Render a fixed-width table. Column widths come from the content so the output
 * stays tight on small collections and still lines up on large ones.
 *
 * @param {readonly string[]} header
 * @param {readonly (readonly string[])[]} rows
 * @param {readonly ('left' | 'right')[]} [align]
 * @returns {string}
 */
export function renderTable(header, rows, align = []) {
  const widths = header.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)),
  );
  /**
   * @param {readonly string[]} cells
   * @returns {string}
   */
  const line = (cells) =>
    cells
      .map((cell, i) =>
        (align[i] ?? 'left') === 'right'
          ? (cell ?? '').padStart(widths[i])
          : (cell ?? '').padEnd(widths[i]),
      )
      .join('  ')
      .trimEnd();
  return [line(header), line(widths.map((w) => '-'.repeat(w))), ...rows.map(line)].join('\n');
}

/**
 * @param {import('./viewmodel.mjs').ViewModel} vm
 * @param {object} [options]
 * @param {number} [options.maxCardRows] 0 for all.
 * @returns {string}
 */
export function renderReport(vm, options = {}) {
  const { maxCardRows = 20 } = options;
  const s = /** @type {any} */ (vm.summary);
  /** @type {string[]} */
  const out = [];

  out.push(`crest - study plan for ${s.examDate} (day ${s.examInDays}, ${s.cards} cards)`);
  out.push('');

  for (const note of vm.notes) out.push(`note: ${note}`);
  if (vm.notes.length > 0) out.push('');

  // ---- Outcome.
  out.push('EXPECTED RECALL ON EXAM DAY');
  /** @type {string[][]} */
  const outcomeRows = [
    [
      'do nothing',
      num(s.expectedRecall.doNothing),
      pct(s.expectedRecallShare.doNothing),
      '',
    ],
  ];
  if (s.expectedRecall.ankiPolicy !== null) {
    outcomeRows.push([
      'study what is due (FSRS/Anki order)',
      num(s.expectedRecall.ankiPolicy),
      pct(/** @type {number} */ (s.expectedRecallShare.ankiPolicy)),
      `+/- ${num(s.expectedRecall.ankiPolicyStderr, 2)} (MC)`,
    ]);
  }
  outcomeRows.push([
    'crest plan',
    num(s.expectedRecall.planned),
    pct(s.expectedRecallShare.planned),
    '',
  ]);
  outcomeRows.push([
    'proven ceiling for this plan family',
    num(s.expectedRecall.upperBound),
    pct(s.expectedRecallShare.upperBound),
    `gap ${pct(s.optimalityGap, 2)}`,
  ]);
  out.push(
    renderTable(['policy', 'cards', 'share', ''], outcomeRows, [
      'left',
      'right',
      'right',
      'left',
    ]),
  );
  out.push('');

  if (s.gainOverAnkiPolicy !== null) {
    const sign = s.gainOverAnkiPolicy >= 0 ? '+' : '';
    out.push(
      `crest beats the study-what-is-due policy by ${sign}${num(s.gainOverAnkiPolicy, 2)} cards ` +
        `(${sign}${pct(s.gainOverAnkiPolicy / Math.max(1, s.cards), 2)} of the collection), ` +
        `using ${num(s.plannedMinutes, 0)} min against its ${num(s.ankiPolicyMinutes, 0)} min.`,
    );
    out.push('');
  }

  if (s.expectedRecall.planSimulated !== null) {
    const delta = Math.abs(s.expectedRecall.planSimulated - s.expectedRecall.planned);
    out.push(
      'cross-check: sampling review outcomes for this plan gives ' +
        `${num(s.expectedRecall.planSimulated, 3)} +/- ${num(s.expectedRecall.planSimulatedStderr, 3)}, ` +
        `against the exact value ${num(s.expectedRecall.planned, 3)} (difference ${num(delta, 3)}).`,
    );
    out.push('');
  }

  // ---- Where the cards went.
  out.push('CARD DISPOSITION');
  out.push(
    renderTable(
      ['group', 'cards', 'meaning'],
      [
        [
          'already safe',
          String(s.cardsSafe),
          'recall on exam day is high enough without any review',
        ],
        ['scheduled', String(s.cardsPlanned), `${s.reviewsScheduled} reviews across the horizon`],
        [
          'not worth saving',
          String(s.cardsAbandoned),
          'the budget buys more recall elsewhere',
        ],
      ],
      ['left', 'right', 'left'],
    ),
  );
  out.push('');

  // ---- The plan.
  out.push('DAILY PLAN');
  out.push(
    renderTable(
      ['day', 'date', '', 'cards', 'minutes', 'budget', 'used', '+cards/extra hour'],
      vm.days.map((d) => {
        const dd = /** @type {any} */ (d);
        return [
          String(dd.day),
          dd.date,
          dd.weekday,
          String(dd.cards),
          num(dd.minutes, 0),
          num(dd.budgetMinutes, 0),
          pct(dd.utilisation, 0),
          dd.utilisation >= 0.995 && dd.extraCardsPerHour > 1e-6
            ? num(dd.extraCardsPerHour, 2)
            : '-',
        ];
      }),
      ['right', 'left', 'left', 'right', 'right', 'right', 'right', 'right'],
    ),
  );
  out.push('');
  out.push(
    `total ${num(s.plannedMinutes, 0)} of ${num(s.totalBudgetMinutes, 0)} budgeted minutes ` +
      `(${pct(s.utilisation, 0)} used).`,
  );
  if (s.bestDayForAnExtraHour) {
    out.push(
      `An extra hour is worth most on day ${s.bestDayForAnExtraHour.day} ` +
        `(${s.bestDayForAnExtraHour.date}): about ` +
        `${num(s.bestDayForAnExtraHour.extraCardsPerHour, 2)} more cards recalled.`,
    );
  } else {
    out.push('No day is saturated: more study time would not raise expected recall.');
  }
  out.push('');

  // ---- Biggest wins.
  if (vm.perCard.length > 0) {
    const shown = maxCardRows > 0 ? vm.perCard.slice(0, maxCardRows) : vm.perCard;
    out.push(
      `CARDS WITH THE LARGEST GAIN (${shown.length} of ${vm.perCard.length} shown)`,
    );
    out.push(
      renderTable(
        ['card', 'review on', 'S', 'D', 'age', 'P(recall) now -> planned', 'gain'],
        shown.map((c) => {
          const cc = /** @type {any} */ (c);
          return [
            cc.cardId,
            cc.dates.join(' '),
            num(cc.stability, 1),
            num(cc.difficulty, 1),
            `${cc.daysSinceReview}d`,
            `${pct(cc.baseline, 0)} -> ${pct(cc.value, 0)}`,
            `+${num(cc.gain, 3)}`,
          ];
        }),
        ['left', 'left', 'right', 'right', 'right', 'right', 'right'],
      ),
    );
    out.push('');
  }

  if (vm.abandoned.length > 0) {
    const shown = vm.abandoned.slice(0, Math.min(10, vm.abandoned.length));
    out.push(
      `NOT WORTH SAVING (${shown.length} of ${vm.abandoned.length} shown, lowest recall first)`,
    );
    out.push(
      renderTable(
        ['card', 'S', 'age', 'P(recall) on exam day'],
        shown.map((c) => {
          const cc = /** @type {any} */ (c);
          return [
            cc.cardId,
            num(cc.stability, 1),
            `${cc.daysSinceReview}d`,
            pct(cc.baseline, 1),
          ];
        }),
        ['left', 'right', 'right', 'right'],
      ),
    );
    out.push('');
    out.push(
      'These are a deliberate choice, not an oversight: within the time available, ' +
        'the same minutes raise expected recall more if spent elsewhere.',
    );
    out.push('');
  }

  out.push(
    `Optimality: the plan scores ${num(s.expectedRecall.planned, 3)}; no assignment that gives ` +
      'each card at most the configured number of reviews, under these same daily budgets, ' +
      `can exceed ${num(s.expectedRecall.upperBound, 3)}. ` +
      `Gap ${pct(s.optimalityGap, 2)} after ${s.solverIterations} dual iterations. ` +
      'The ceiling does not cover policies that review one card more often than that; ' +
      'if the due-order baseline above is close or ahead, raise --max-reviews.',
  );
  if (s.maxPrunedMass > 0) {
    out.push(
      `Valuations pruned at most ${num(s.maxPrunedMass, 6)} probability mass per card ` +
        '(run without --epsilon for exact values).',
    );
  }
  return out.join('\n');
}
