// Unit tests for the CDP-agnostic repeatUntilStable polling primitive (#275).
// No browser.mjs / dom_extractor.js / CDP fakes here — tick, isStable and sleep
// are all plain fakes the test controls directly.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { repeatUntilStable } from '../.claude/skills/qcomm/scripts/repeat_until_stable.mjs';

describe('repeatUntilStable', () => {
  it('resolves stable:true with the stabilizing value once isStable holds for stableTarget consecutive ticks', async () => {
    const values = [1, 2, 3, 3, 3, 4];
    let i = 0;
    const tick = () => values[i++];
    const isStable = (current, previous) => current === previous;

    const result = await repeatUntilStable({
      tick,
      isStable,
      stableTarget: 2,
      maxRounds: 10,
      sleepMs: 5,
      sleep: async () => {},
    });

    assert.deepEqual(result, { value: 3, stable: true, rounds: 5 });
  });

  it('resolves stable:false with the last value once maxRounds ticks run without reaching stableTarget, and never throws', async () => {
    let i = 0;
    const tick = () => ++i; // always a new value, never stable
    const isStable = (current, previous) => current === previous;

    const result = await repeatUntilStable({
      tick,
      isStable,
      stableTarget: 2,
      maxRounds: 3,
      sleepMs: 5,
      sleep: async () => {},
    });

    assert.deepEqual(result, { value: 3, stable: false, rounds: 3 });
  });

  it('reflects the number of ticks actually run in rounds, not maxRounds, when it stops early', async () => {
    const tick = () => 'same';
    const isStable = (current, previous) => current === previous;

    const result = await repeatUntilStable({
      tick,
      isStable,
      stableTarget: 1,
      maxRounds: 10,
      sleepMs: 5,
      sleep: async () => {},
    });

    // tick 1: no previous yet -> not stable. tick 2: 'same' === 'same' -> stable, stop.
    assert.deepEqual(result, { value: 'same', stable: true, rounds: 2 });
  });

  it('sleeps sleepMs between ticks (via the injected fake sleep, not real timers)', async () => {
    const calls = [];
    const fakeSleep = async (ms) => {
      calls.push(ms);
    };
    let i = 0;
    const tick = () => ++i;
    const isStable = () => false;

    const result = await repeatUntilStable({
      tick,
      isStable,
      stableTarget: 2,
      maxRounds: 4,
      sleepMs: 250,
      sleep: fakeSleep,
    });

    assert.equal(result.stable, false);
    assert.equal(result.rounds, 4);
    // sleep happens between ticks only: 4 ticks -> 3 sleeps, never after the last tick.
    assert.deepEqual(calls, [250, 250, 250]);
  });
});
