import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { Me, User } from '@yugioh/shared';
import { useState } from 'react';
import { ApiError, api } from '../api.ts';

const problems: Record<string, string> = {
  username_taken: 'Someone already has that username.',
  invalid_username: 'Use 3 to 32 letters, digits, _ or -.',
};

/** The account's username, which other players see, and a way to change it. */
export function Username({ user }: { user: User }) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (username: string) => api<User>('/me/username', { method: 'POST', body: JSON.stringify({ username }) }),
    onSuccess: (updated) => {
      queryClient.setQueryData<Me>(['me'], (me) => me?.kind === 'user' ? { ...me, user: updated } : me);
      setDraft(null);
    },
  });

  if (draft === null)
    return (
      <div className="row">
        <span>
          <span className="muted small">Username</span>
          <br />
          <strong>{user.username}</strong>
        </span>
        <span className="spacer" />
        <button className="quiet" onClick={() => setDraft(user.username)}>Change</button>
      </div>
    );

  const error = save.error instanceof ApiError ? (save.error.body as { error?: string } | null)?.error : undefined;
  return (
    <form
      className="row"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate(draft);
      }}
    >
      <input aria-label="Username" maxLength={32} value={draft} onChange={(e) => setDraft(e.target.value)} autoFocus />
      <button type="submit" className="primary" disabled={save.isPending || draft.trim() === ''}>Save</button>
      <button type="button" className="quiet" onClick={() => (save.reset(), setDraft(null))}>Cancel</button>
      {save.isError && <span className="error small">{(error && problems[error]) ?? 'Something went wrong. Try again.'}</span>}
    </form>
  );
}
