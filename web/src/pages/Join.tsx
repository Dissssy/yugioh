import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { InvitePreview, InviteProblem, Me } from '@yugioh/shared';
import { Link, useParams } from 'react-router';
import { api, ApiError } from '../api.ts';
import { formatDate } from './Home.tsx';

const problems: Record<InviteProblem, string> = {
  not_found: "This invite link doesn't work. Ask the person who sent it for a new one.",
  expired: 'This invite link has expired. Ask the person who sent it for a new one.',
  used: 'This invite link has already been used.',
};

function problemOf(error: unknown): string {
  const problem = error instanceof ApiError ? (error.body as { problem?: InviteProblem })?.problem : undefined;
  return problem ? problems[problem] : 'Something went wrong. Try again.';
}

export function Join({ me }: { me: Me }) {
  const { token = '' } = useParams();
  const queryClient = useQueryClient();
  const preview = useQuery({ queryKey: ['join', token], queryFn: () => api<InvitePreview>(`/join/${token}`) });
  const join = useMutation({
    mutationFn: () => api<Me>(`/join/${token}`, { method: 'POST' }),
    onSuccess: (next) => queryClient.setQueryData(['me'], next),
  });

  if (me.kind === 'user') return <p>You're signed in, so you don't need an invite. <Link to="/">Go home</Link></p>;
  if (preview.isPending) return <p>Loading…</p>;
  if (preview.isError) return <p className="error">{problemOf(preview.error)}</p>;
  if (me.kind === 'guest')
    return <p>You're in as {me.invite.invitedBy}'s guest. <Link to="/">Continue</Link></p>;

  return (
    <section>
      <h1>{preview.data.invitedBy} invited you</h1>
      <p>Join as a guest to play without an account. The invite lasts until {formatDate(preview.data.expiresAt)}.</p>
      <button onClick={() => join.mutate()} disabled={join.isPending}>Join as guest</button>
      {join.isError && <p className="error">{problemOf(join.error)}</p>}
    </section>
  );
}
