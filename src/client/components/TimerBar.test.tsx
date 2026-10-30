import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { TimerBar, type TimerBarProps } from './TimerBar';
import type { TimerState } from '../../shared/types';

const running = (endsAt: number): TimerState => ({ status: 'running', durationMs: 300_000, endsAt, remainingMs: 300_000 });
const idle: TimerState = { status: 'idle', durationMs: 300_000, endsAt: null, remainingMs: 300_000 };

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(50_000_000));
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const props = (o: Partial<TimerBarProps> = {}): TimerBarProps => ({
  timer: idle, serverNow: 0, receivedAt: Date.now(), isAdmin: false, emit: vi.fn().mockResolvedValue({ ok: true }), ...o,
});

test('TimerBar shows server-based remaining despite local clock skew', () => {
  // Server clock is ~13.9h behind the local clock; 45s remain by the server's reckoning.
  render(<TimerBar {...props({ timer: running(1_000_000 + 45_000), serverNow: 1_000_000 })} />);
  expect(screen.getByRole('timer').textContent).toBe('00:45');
  act(() => { vi.advanceTimersByTime(5_000); });
  expect(screen.getByRole('timer').textContent).toBe('00:40');
});

test('TimerBar hides controls for non-admin', () => {
  render(<TimerBar {...props()} />);
  expect(screen.queryByRole('button', { name: 'Start' })).toBeNull();
  expect(screen.queryByRole('button', { name: '+1 min' })).toBeNull();
});

test('admin starts with a preset or custom minutes', () => {
  const p = props({ isAdmin: true });
  render(<TimerBar {...p} />);
  fireEvent.click(screen.getByRole('button', { name: '10 min' }));
  fireEvent.click(screen.getByRole('button', { name: 'Start' }));
  expect(p.emit).toHaveBeenLastCalledWith('admin:timer', { type: 'start', durationMs: 600_000 });
  fireEvent.change(screen.getByLabelText('Custom minutes'), { target: { value: '7' } });
  fireEvent.click(screen.getByRole('button', { name: 'Start' }));
  expect(p.emit).toHaveBeenLastCalledWith('admin:timer', { type: 'start', durationMs: 420_000 });
  fireEvent.change(screen.getByLabelText('Custom minutes'), { target: { value: '181' } });
  expect((screen.getByRole('button', { name: 'Start' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: '+1 min' }));
  expect(p.emit).toHaveBeenLastCalledWith('admin:timer', { type: 'addMinute' });
});

test('running shows Pause and Reset; paused shows Resume', () => {
  const p = props({ isAdmin: true, timer: running(Date.now() + 60_000), serverNow: Date.now() });
  const { rerender } = render(<TimerBar {...p} />);
  fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
  expect(p.emit).toHaveBeenLastCalledWith('admin:timer', { type: 'pause' });
  rerender(<TimerBar {...p} timer={{ status: 'paused', durationMs: 300_000, endsAt: null, remainingMs: 30_000 }} />);
  fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
  expect(p.emit).toHaveBeenLastCalledWith('admin:timer', { type: 'resume' });
  fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
  expect(p.emit).toHaveBeenLastCalledWith('admin:timer', { type: 'reset' });
});

function stubAudio() {
  const start = vi.fn();
  class Ctx {
    currentTime = 0;
    destination = {};
    createOscillator() { return { frequency: { value: 0 }, connect: vi.fn(), start, stop: vi.fn(), onended: null }; }
    createGain() { return { gain: { value: 0 }, connect: vi.fn() }; }
    close() { return Promise.resolve(); }
  }
  vi.stubGlobal('AudioContext', Ctx);
  (window as unknown as { AudioContext: unknown }).AudioContext = Ctx;
  return start;
}

test("Time's up shows once and beeps once per run only when sound is on", () => {
  const start = stubAudio();
  localStorage.setItem('retro.sound', 'on');
  render(<TimerBar {...props({ timer: running(Date.now() + 1_000), serverNow: Date.now() })} />);
  expect(screen.queryByText("Time's up")).toBeNull();
  act(() => { vi.advanceTimersByTime(3_000); });
  expect(screen.getByText("Time's up")).toBeTruthy();
  expect(screen.getByRole('timer').textContent).toBe('00:00');
  expect(start).toHaveBeenCalledTimes(1);
});

test("no beep when sound is off (default)", () => {
  const start = stubAudio();
  render(<TimerBar {...props({ timer: running(Date.now() + 1_000), serverNow: Date.now() })} />);
  act(() => { vi.advanceTimersByTime(3_000); });
  expect(screen.getByText("Time's up")).toBeTruthy();
  expect(start).not.toHaveBeenCalled();
});

test('sound toggle persists to localStorage and missing AudioContext does not throw', () => {
  const p = props({ timer: running(Date.now() + 1_000), serverNow: Date.now() });
  (window as unknown as { AudioContext?: unknown }).AudioContext = undefined;
  render(<TimerBar {...p} />);
  fireEvent.click(screen.getByLabelText('Sound'));
  expect(localStorage.getItem('retro.sound')).toBe('on');
  act(() => { vi.advanceTimersByTime(3_000); });
  expect(screen.getByText("Time's up")).toBeTruthy();
});
