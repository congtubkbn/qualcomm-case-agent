// CDP-agnostic polling primitive (#275): ticks a caller-supplied function until
// its result stops changing, or gives up after maxRounds. Never imports
// browser.mjs, dom_extractor.js, or any CDP type — cdp_portal_driver.mjs's
// expand-loop is a candidate future caller (#274), not a dependency of this file.

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {Object} opts
 * @param {() => any | Promise<any>} opts.tick Produces the next value to check.
 * @param {(current: any, previous: any) => boolean} opts.isStable Compares
 *   the current tick's value against the previous tick's value. On tick 1,
 *   `previous` is `undefined` — repeatUntilStable does not force tick 1 to
 *   be unstable, so a comparator that would treat `undefined` as a match
 *   must guard that itself.
 * @param {number} opts.stableTarget Consecutive stable ticks required to stop early.
 * @param {number} opts.maxRounds Hard ceiling on ticks run, win or lose.
 * @param {number} opts.sleepMs Delay between ticks.
 * @param {(ms: number) => Promise<void>} [opts.sleep] Injectable for tests — defaults to a real timer.
 * @returns {Promise<{ value: any, stable: boolean, rounds: number }>}
 */
export async function repeatUntilStable({
  tick,
  isStable,
  stableTarget,
  maxRounds,
  sleepMs,
  sleep = defaultSleep,
}) {
  let value;
  let previous;
  let stableCount = 0;
  let rounds = 0;

  while (rounds < maxRounds) {
    value = await tick();
    stableCount = isStable(value, previous) ? stableCount + 1 : 0;
    previous = value;
    rounds++;

    if (stableCount >= stableTarget) {
      return { value, stable: true, rounds };
    }
    if (rounds < maxRounds) {
      await sleep(sleepMs);
    }
  }

  return { value, stable: false, rounds };
}
