import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Invite } from '@yugioh/shared';
import { api } from '../api.ts';
import { formatDate } from './Home.tsx';

const linkFor = (token: string) => `${window.location.origin}/join/${token}`;

export function Invites() {
  const queryClient = useQueryClient();
  const invites = useQuery({ queryKey: ['invites'], queryFn: () => api<Invite[]>('/invites') });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['invites'] });
  const create = useMutation({ mutationFn: () => api<Invite>('/invites', { method: 'POST' }), onSuccess: refresh });
  const revoke = useMutation({
    mutationFn: (token: string) => api(`/invites/${token}`, { method: 'DELETE' }),
    onSuccess: refresh,
  });

  return (
    <>
      <h2>Invites</h2>
      <p>An invite link lets one person without an account play as your guest for a week.</p>
      <button onClick={() => create.mutate()} disabled={create.isPending}>Create invite link</button>
      {invites.data && invites.data.length > 0 && (
        <ul className="list">
          {invites.data.map((invite) => {
            const expired = new Date(invite.expiresAt) <= new Date();
            return (
              <li key={invite.token}>
                <input readOnly value={linkFor(invite.token)} onFocus={(e) => e.target.select()} />
                <span className="muted">
                  {invite.redeemedAt ? `Used ${formatDate(invite.redeemedAt)}` : expired ? 'Expired' : `Unused, expires ${formatDate(invite.expiresAt)}`}
                </span>
                <button onClick={() => navigator.clipboard.writeText(linkFor(invite.token))}>Copy</button>
                <button onClick={() => revoke.mutate(invite.token)}>Revoke</button>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
