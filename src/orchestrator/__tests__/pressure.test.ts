import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PressureTracker,
  PRESSURE_BLOCK_THRESHOLD,
  computePressure,
} from '../pressure';

test('computePressure: zero when limit is 0', () => {
  assert.equal(
    computePressure({ tokensRemaining: 0, tokensLimit: 0, resetAt: 0 }),
    0,
  );
});

test('computePressure: half-used → 0.5', () => {
  assert.equal(
    computePressure({ tokensRemaining: 50, tokensLimit: 100, resetAt: 0 }),
    0.5,
  );
});

test('computePressure: clamps to [0, 1]', () => {
  assert.equal(
    computePressure({ tokensRemaining: -100, tokensLimit: 100, resetAt: 0 }),
    1,
  );
  assert.equal(
    computePressure({ tokensRemaining: 200, tokensLimit: 100, resetAt: 0 }),
    0,
  );
});

test('PressureTracker: returns 0 when no observation', () => {
  const t = new PressureTracker({ now: () => 1000 });
  assert.equal(t.pressureFor('w1'), 0);
});

test('PressureTracker: records headers and reports pressure', () => {
  const t = new PressureTracker({ now: () => 1000 });
  t.recordHeaders('w1', {
    tokensRemaining: 10,
    tokensLimit: 100,
    resetAt: 5000,
  });
  assert.equal(t.pressureFor('w1'), 0.9);
});

test('PressureTracker: shouldDispatch is false when pressure ≥ threshold', () => {
  const t = new PressureTracker({ now: () => 1000 });
  t.recordHeaders('w1', {
    tokensRemaining: 10,
    tokensLimit: 100,
    resetAt: 5000,
  });
  assert.equal(t.pressureFor('w1') >= PRESSURE_BLOCK_THRESHOLD, true);
  assert.equal(t.shouldDispatch('w1'), false);
});

test('PressureTracker: shouldDispatch is true under threshold', () => {
  const t = new PressureTracker({ now: () => 1000 });
  t.recordHeaders('w1', {
    tokensRemaining: 50,
    tokensLimit: 100,
    resetAt: 5000,
  });
  assert.equal(t.shouldDispatch('w1'), true);
});

test('PressureTracker: pressure drops to 0 after reset', () => {
  let clock = 1000;
  const t = new PressureTracker({ now: () => clock });
  t.recordHeaders('w1', {
    tokensRemaining: 5,
    tokensLimit: 100,
    resetAt: 2000,
  });
  assert.ok(t.pressureFor('w1') > PRESSURE_BLOCK_THRESHOLD);
  clock = 3000;
  assert.equal(t.pressureFor('w1'), 0);
});

test('PressureTracker: nextAvailableSlot returns resetAt when blocked', () => {
  const t = new PressureTracker({ now: () => 1000 });
  t.recordHeaders('w1', {
    tokensRemaining: 5,
    tokensLimit: 100,
    resetAt: 5000,
  });
  assert.equal(t.nextAvailableSlot('w1'), 5000);
});

test('PressureTracker: nextAvailableSlot returns now when not blocked', () => {
  const t = new PressureTracker({ now: () => 1000 });
  t.recordHeaders('w1', {
    tokensRemaining: 50,
    tokensLimit: 100,
    resetAt: 5000,
  });
  assert.equal(t.nextAvailableSlot('w1'), 1000);
});
