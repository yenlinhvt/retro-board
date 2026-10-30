import type { TimerAction, TimerState } from './types';

export const IDLE_TIMER: TimerState = { status: 'idle', durationMs: 300_000, endsAt: null, remainingMs: 300_000 };

const MIN_DURATION_MS = 10_000;
const MAX_DURATION_MS = 3 * 60 * 60 * 1000;
const MINUTE_MS = 60_000;

/** Time left at `now`, clamped to >= 0. Paused/idle timers report their frozen value. */
export function remainingMs(state: TimerState, now: number): number {
  if (state.status === 'running' && state.endsAt !== null) return Math.max(0, state.endsAt - now);
  return Math.max(0, state.remainingMs);
}

/** Pure transition; invalid actions for the current state return `state` unchanged. */
export function applyTimerAction(state: TimerState, action: TimerAction, now: number): TimerState {
  switch (action.type) {
    case 'start': {
      const d = action.durationMs;
      if (!Number.isFinite(d) || d < MIN_DURATION_MS || d > MAX_DURATION_MS) return state;
      return { status: 'running', durationMs: d, endsAt: now + d, remainingMs: d };
    }
    case 'pause': {
      if (state.status !== 'running') return state;
      return { ...state, status: 'paused', endsAt: null, remainingMs: remainingMs(state, now) };
    }
    case 'resume': {
      if (state.status !== 'paused') return state;
      return { ...state, status: 'running', endsAt: now + state.remainingMs };
    }
    case 'reset':
      return { status: 'idle', durationMs: state.durationMs, endsAt: null, remainingMs: state.durationMs };
    case 'addMinute': {
      if (state.status === 'idle') {
        return { status: 'running', durationMs: MINUTE_MS, endsAt: now + MINUTE_MS, remainingMs: MINUTE_MS };
      }
      const remaining = remainingMs(state, now) + MINUTE_MS;
      return {
        status: state.status,
        durationMs: state.durationMs + MINUTE_MS,
        endsAt: state.status === 'running' ? now + remaining : null,
        remainingMs: remaining,
      };
    }
  }
}
