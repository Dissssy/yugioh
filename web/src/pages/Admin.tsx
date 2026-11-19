import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AccountStatus, AdminUser, DuelSummary } from '@yugioh/shared';
import { api, errorText } from '../api.ts';
import { formatDate } from './Home.tsx';
import { Loading, Notice } from './Notice.tsx';

const order: Record<AccountStatus, number> = { pending: 0, approved: 1, rejected: 2 };

export function Admin() {
  return (
    <>
      <Accounts />
      <RecentDuels />
    </>
  );
}

/** Everyone's latest duels, each with its full log for review: every card, intent, ruling, appeal and chat message. */
function RecentDuels() {
  const duels = useQuery({ queryKey: ['admin', 'duels'], queryFn: () => api<DuelSummary[]>('/admin/duels') });
  if (!duels.data) return null;
  return (
    <section className="box admin">
      <div className="page-head">
        <h1>Duels</h1>
      </div>
      <div className="table-scroll">
        <table>
          <thead>
            <tr><th>Duel</th><th>Created</th><th>Status</th><th>Decks</th><th /></tr>
          </thead>
          <tbody>
            {duels.data.map((duel) => (
              <tr key={duel.id}>
                <td><a href={`/duel/${duel.id}`}><code>{duel.id}</code></a></td>
                <td className="muted">{formatDate(duel.createdAt)}</td>
                <td><span className="pill">{duel.status}</span></td>
                <td className="muted">{duel.createdBy}: {duel.decks[0]} vs {duel.decks[1] ?? '…'}</td>
                <td className="cell-actions">
                  <a href={`/api/admin/duels/${duel.id}/report`} target="_blank" rel="noreferrer">Full log</a>{' '}
                  <a href={`/api/admin/duels/${duel.id}/report?format=json`} target="_blank" rel="noreferrer">JSON</a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Accounts() {
  const queryClient = useQueryClient();
  const users = useQuery({ queryKey: ['admin', 'users'], queryFn: () => api<AdminUser[]>('/admin/users') });
  const setStatus = useMutation({
    mutationFn: ({ id, status }: { id: number; status: AccountStatus }) =>
      api<AdminUser>(`/admin/users/${id}/status`, { method: 'POST', body: JSON.stringify({ status }) }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin', 'users'] }),
  });

  if (users.isError) return <Notice title="Admins only" tone="error">Only the admin can see this page.</Notice>;
  if (!users.data) return <Loading />;

  const sorted = [...users.data].sort((a, b) => order[a.status] - order[b.status]);
  const pending = sorted.filter((u) => u.status === 'pending').length;
  return (
    <section className="box admin">
      <div className="page-head">
        <h1>Accounts</h1>
        <span className={`pill${pending ? ' waiting' : ''}`}>{pending ? `${pending} waiting for approval` : 'No one waiting'}</span>
      </div>
      {setStatus.isError && <p className="error">{errorText(setStatus.error)}</p>}
      <div className="table-scroll">
        <table>
          <thead>
            <tr><th>Username</th><th>Email</th><th>Signed up</th><th>Status</th><th /></tr>
          </thead>
          <tbody>
            {sorted.map((user) => (
              <tr key={user.id} className={user.status}>
                <td><strong>{user.username}</strong></td>
                <td className="muted">{user.email}</td>
                <td className="muted">{formatDate(user.createdAt)}</td>
                <td><span className={`pill ${user.isAdmin ? 'admin' : user.status}`}>{user.isAdmin ? 'admin' : user.status}</span></td>
                <td className="cell-actions">
                  {!user.isAdmin &&
                    (['approved', 'rejected'] as const)
                      .filter((s) => s !== user.status)
                      .map((status) => (
                        <button
                          key={status}
                          className={status === 'approved' ? 'primary' : 'quiet'}
                          disabled={setStatus.isPending}
                          onClick={() => setStatus.mutate({ id: user.id, status })}
                        >
                          {status === 'approved' ? 'Approve' : 'Reject'}
                        </button>
                      ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
