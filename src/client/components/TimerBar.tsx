import { useEffect, useRef, useState } from 'react';
import { clientRemainingMs } from '../../shared/timer';
import type { TimerAction, TimerState } from '../../shared/types';
import type { Emit } from '../lib/useBoard';

const SOUND_KEY = 'retro.sound';
const PRESETS = [3, 5, 10];
const MIN_MINUTES = 1;
const MAX_MINUTES = 180;

function readSound(): boolean {
  try {
    return localStorage.getItem(SOUND_KEY) === 'on';
  } catch {
    return false;
  }
}

function writeSound(on: boolean): void {
  try {
    localStorage.setItem(SOUND_KEY, on ? 'on' : 'off');
  } catch {
    /* ignore */
  }
}

function makeContext(): AudioContext | null {
  try {
    const Ctx: typeof AudioContext | undefined =
      window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    return Ctx ? new Ctx() : null;
  } catch {
    return null;
  }
}

function beep(ctx: AudioContext): void {
  try {
    void ctx.resume?.();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = 880;
    gain.gain.value = 0.15;
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.4);
  } catch {
    /* audio unavailable */
  }
}

export function formatClock(ms: number): string {
  const total = Math.ceil(ms / 1000);
  const mm = Math.floor(total / 60);
  const ss = total % 60;
  return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}

export type TimerBarProps = {
  timer: TimerState;
  serverNow: number;
  receivedAt: number;
  isAdmin: boolean;
  emit: Emit;
};

export function TimerBar({ timer, serverNow, receivedAt, isAdmin, emit }: TimerBarProps) {
  const [now, setNow] = useState(() => Date.now());
  const [sound, setSound] = useState(readSound);
  const [minutes, setMinutes] = useState(() => String(Math.max(MIN_MINUTES, Math.round(timer.durationMs / 60_000))));
  const soundRef = useRef(sound);
  soundRef.current = sound;
  const prevRemaining = useRef<number | null>(null);
  const audioRef = useRef<AudioContext | null>(null);
  const beepedFor = useRef<number | null>(null);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, []);

  const remaining = clientRemainingMs(timer, serverNow, receivedAt, now);
  const timesUp = timer.status === 'running' && remaining === 0;

  useEffect(() => {
    const prev = prevRemaining.current;
    prevRemaining.current = remaining;
    // Only beep when the countdown is seen reaching zero (not for an already-expired timer on load).
    if (timesUp && prev !== null && prev > 0 && beepedFor.current !== timer.endsAt && soundRef.current) {
      beepedFor.current = timer.endsAt;
      audioRef.current ??= makeContext();
      if (audioRef.current) beep(audioRef.current);
    }
  }, [remaining, timesUp, timer.endsAt]);

  const mins = Number(minutes);
  const validMinutes = Number.isInteger(mins) && mins >= MIN_MINUTES && mins <= MAX_MINUTES;
  const send = (action: TimerAction) => void emit('admin:timer', action);

  return (
    <section aria-label="Timer" className={`timer-bar${timesUp ? ' timer-bar--up' : ''}`}>
      <span className="timer-clock" role="timer" aria-label="Time remaining">
        {formatClock(remaining)}
      </span>
      {timesUp && <strong className="timer-up">Time's up</strong>}
      <label className="timer-sound">
        <input
          type="checkbox"
          checked={sound}
          onChange={(e) => {
            setSound(e.target.checked);
            // Create/resume inside the click so the browser allows playback later.
            if (e.target.checked) {
              audioRef.current ??= makeContext();
              void audioRef.current?.resume?.();
            }
            writeSound(e.target.checked);
          }}
        />{' '}
        Sound
      </label>
      {isAdmin && (
        <div className="timer-controls">
          {timer.status === 'idle' && (
            <>
              {PRESETS.map((m) => (
                <button
                  key={m}
                  type="button"
                  className={`btn btn-secondary btn-small${mins === m ? ' is-active' : ''}`}
                  aria-pressed={mins === m}
                  onClick={() => setMinutes(String(m))}
                >
                  {m} min
                </button>
              ))}
              <input
                type="number"
                aria-label="Custom minutes"
                min={MIN_MINUTES}
                max={MAX_MINUTES}
                value={minutes}
                onChange={(e) => setMinutes(e.target.value)}
                style={{ width: '5em' }}
              />
              <button
                type="button"
                className="btn btn-primary btn-small"
                disabled={!validMinutes}
                onClick={() => send({ type: 'start', durationMs: mins * 60_000 })}
              >
                Start
              </button>
            </>
          )}
          {timer.status === 'running' && (
            <button type="button" className="btn btn-secondary btn-small" onClick={() => send({ type: 'pause' })}>
              Pause
            </button>
          )}
          {timer.status === 'paused' && (
            <button type="button" className="btn btn-secondary btn-small" onClick={() => send({ type: 'resume' })}>
              Resume
            </button>
          )}
          {timer.status !== 'idle' && (
            <button type="button" className="btn btn-secondary btn-small" onClick={() => send({ type: 'reset' })}>
              Reset
            </button>
          )}
          <button type="button" className="btn btn-secondary btn-small" onClick={() => send({ type: 'addMinute' })}>
            +1 min
          </button>
        </div>
      )}
    </section>
  );
}
