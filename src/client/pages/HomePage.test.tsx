import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, test, vi } from 'vitest';
import { HomePage } from './HomePage';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function mockFetch(impl: () => Promise<unknown>) {
  const fn = vi.fn(impl);
  vi.stubGlobal('fetch', fn);
  return fn;
}
const json = (status: number, body: unknown) => Promise.resolve({ status, json: () => Promise.resolve(body) });

async function submit() {
  render(
    <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <HomePage />
    </MemoryRouter>,
  );
  fireEvent.change(screen.getByLabelText('Board name'), { target: { value: 'Sprint 12' } });
  fireEvent.change(screen.getByLabelText('Invite code'), { target: { value: 'code' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create board' }));
}

test('HomePage shows both links after creating', async () => {
  const fetchFn = mockFetch(() =>
    json(201, {
      boardId: 'b1',
      adminToken: 'tok',
      participantUrl: 'https://retro.example.com/b/b1',
      adminUrl: 'https://retro.example.com/b/b1?admin=tok',
    }),
  );
  await submit();
  expect(await screen.findByText('https://retro.example.com/b/b1')).toBeTruthy();
  expect(screen.getByText('https://retro.example.com/b/b1?admin=tok')).toBeTruthy();
  expect(screen.getByText('Your admin link — keep it secret')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Open as admin' })).toBeTruthy();
  expect(JSON.parse((fetchFn.mock.calls[0] as any)[1].body)).toEqual({ name: 'Sprint 12', inviteCode: 'code' });
});

test.each([
  [403, {}, "That invite code isn't valid."],
  [429, {}, 'Too many attempts — try again in a minute.'],
  [400, { error: 'invalid_input', message: 'Board name is too long' }, 'Board name is too long'],
])('HomePage shows error for status %i', async (status, body, text) => {
  mockFetch(() => json(status, body));
  await submit();
  await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(text));
});

test('HomePage shows network error', async () => {
  mockFetch(() => Promise.reject(new TypeError('failed')));
  await submit();
  await waitFor(() => expect(screen.getByRole('alert').textContent).toBe("Couldn't reach the server."));
});
