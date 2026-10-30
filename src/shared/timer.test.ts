import { describe, expect, test } from 'vitest';
import type { TimerState } from './types';
import { applyTimerAction, IDLE_TIMER, remainingMs } from './timer';

const T0 = 1_000_000;

describe('timer', () => {
  test('start sets running with endsAt = now + duration', () => {
    const s = applyTimerAction(IDLE_TIMER, { type: 'start', durationMs: 300_000 }, T0);
    expect(s).toEqual({ status: 'running', durationMs: 300_000, endsAt: T0 + 300_000, remainingMs: 300_000 });
  });
  test('start rejects durations outside 10s-3h', () => {
    expect(applyTimerAction(IDLE_TIMER, { type: 'start', durationMs: 9_999 }, T0)).toEqual(IDLE_TIMER);
    expect(applyTimerAction(IDLE_TIMER, { type: 'start', durationMs: 10_800_001 }, T0)).toEqual(IDLE_TIMER);
    expect(applyTimerAction(IDLE_TIMER, { type: 'start', durationMs: 10_000 }, T0).status).toBe('running');
    expect(applyTimerAction(IDLE_TIMER, { type: 'start', durationMs: 10_800_000 }, T0).status).toBe('running');
  });
  test('pause freezes remaining, resume continues from it', () => {
    let s = applyTimerAction(IDLE_TIMER, { type: 'start', durationMs: 60_000 }, T0);
    s = applyTimerAction(s, { type: 'pause' }, T0 + 20_000);
    expect(s.status).toBe('paused');
    expect(s.remainingMs).toBe(40_000);
    expect(s.endsAt).toBeNull();
    s = applyTimerAction(s, { type: 'resume' }, T0 + 100_000);
    expect(s.endsAt).toBe(T0 + 140_000);
  });
  test('addMinute extends running and paused timers, and starts a 60s timer when idle', () => {
    const r = applyTimerAction(applyTimerAction(IDLE_TIMER, { type: 'start', durationMs: 10_000 }, T0), { type: 'addMinute' }, T0);
    expect(r.endsAt).toBe(T0 + 70_000);
    const p = applyTimerAction(applyTimerAction(applyTimerAction(IDLE_TIMER, { type: 'start', durationMs: 60_000 }, T0), { type: 'pause' }, T0 + 10_000), { type: 'addMinute' }, T0 + 20_000);
    expect(p).toMatchObject({ status: 'paused', endsAt: null, remainingMs: 110_000 });
    const i = applyTimerAction(IDLE_TIMER, { type: 'addMinute' }, T0);
    expect(i).toMatchObject({ status: 'running', endsAt: T0 + 60_000 });
  });
  test('reset returns to idle keeping durationMs', () => {
    const s = applyTimerAction(applyTimerAction(IDLE_TIMER, { type: 'start', durationMs: 15_000 }, T0), { type: 'reset' }, T0 + 1);
    expect(s).toEqual({ status: 'idle', durationMs: 15_000, endsAt: null, remainingMs: 15_000 });
  });
  test('remainingMs clamps to 0 after expiry and works for paused', () => {
    const s: TimerState = { status: 'running', durationMs: 1_000, endsAt: T0 + 1_000, remainingMs: 1_000 };
    expect(remainingMs(s, T0 + 400)).toBe(600);
    expect(remainingMs(s, T0 + 5_000)).toBe(0);
    const p = applyTimerAction(applyTimerAction(IDLE_TIMER, { type: 'start', durationMs: 60_000 }, T0), { type: 'pause' }, T0 + 20_000);
    expect(remainingMs(p, T0 + 999_999)).toBe(40_000);
  });
  test('pause/resume on wrong state is a no-op', () => {
    expect(applyTimerAction(IDLE_TIMER, { type: 'pause' }, T0)).toEqual(IDLE_TIMER);
    expect(applyTimerAction(IDLE_TIMER, { type: 'resume' }, T0)).toEqual(IDLE_TIMER);
    const running = applyTimerAction(IDLE_TIMER, { type: 'start', durationMs: 60_000 }, T0);
    expect(applyTimerAction(running, { type: 'resume' }, T0 + 1)).toEqual(running);
  });
});
