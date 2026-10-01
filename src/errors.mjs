// @ts-check
/**
 * @file Error types.
 *
 * `crest` distinguishes three failure kinds so the CLI can map them to exit
 * codes and so that a bug in the solver is never silently reported as bad user
 * input:
 *
 *   CrestError   - the caller did something wrong (bad CSV, bad flag, bad
 *                  parameter vector). Recoverable by fixing the input.
 *   InvariantError - `crest` did something wrong. An assertion about its own
 *                  state failed. Never catch this to continue; it means a
 *                  result would be untrustworthy.
 *
 * Nothing in this project swallows an exception. If a computation cannot be
 * completed the process exits non-zero with the reason on stderr.
 */

/** A problem with the caller's input or environment. */
export class CrestError extends Error {
  /**
   * @param {string} message
   * @param {{cause?: unknown, hint?: string}} [options]
   */
  constructor(message, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'CrestError';
    /** @type {string | undefined} Actionable next step, shown after the message. */
    this.hint = options.hint;
  }
}

/**
 * An internal consistency check failed. This is always a bug in `crest`.
 */
export class InvariantError extends Error {
  /**
   * @param {string} message
   * @param {Record<string, unknown>} [context] Values that made the check fail,
   *   printed alongside the message so the failure is reproducible.
   */
  constructor(message, context = {}) {
    const detail = Object.entries(context)
      .map(([k, v]) => `${k}=${typeof v === 'number' ? v : JSON.stringify(v)}`)
      .join(' ');
    super(detail ? `${message} (${detail})` : message);
    this.name = 'InvariantError';
    this.context = context;
  }
}

/**
 * Assert an internal invariant. Unlike `console.assert`, this throws.
 *
 * @param {unknown} condition
 * @param {string} message
 * @param {Record<string, unknown>} [context]
 * @returns {void}
 */
export function invariant(condition, message, context = {}) {
  if (!condition) {
    throw new InvariantError(message, context);
  }
}
