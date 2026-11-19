import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import type { AccountStatus, AdminUser, CostReport } from '@yugioh/shared';
import { api, errorText } from '../api.ts';
import { formatDate } from './Home.tsx';
import { Loading, Notice } from './Notice.tsx';

const order: Record<AccountStatus, number> = { pending: 0, approved: 1, rejected: 2 };

export function Admin() {
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
    <>
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
      <Costs />
    </>
  );
}

/** Dollars, with more decimals for the small amounts one duel costs. */
const usd = (n: number) => `$${n.toFixed(n < 1 ? 4 : 2)}`;

/** What the judge and appeals cost, per duel and in total. */
function Costs() {
  const costs = useQuery({ queryKey: ['admin', 'costs'], queryFn: () => api<CostReport>('/admin/costs') });
  if (costs.isError) return <p className="error">{errorText(costs.error)}</p>;
  if (!costs.data) return <Loading />;
  const { total, duels } = costs.data;
  return (
    <section className="box admin">
      <div className="page-head">
        <h1>Judge costs</h1>
        <span className="pill">{usd(total)} in total</span>
      </div>
      <p className="muted">Estimated from the tokens each judge call and appeal used, at Anthropic's list prices.</p>
      {duels.length === 0 ? (
        <p className="muted">No duel has used the judge yet.</p>
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr><th>Duel</th><th>Started</th><th>Status</th><th>Judge calls</th><th>Appeals</th><th>Cost</th></tr>
            </thead>
            <tbody>
              {duels.map((d) => (
                <tr key={d.id}>
                  <td><Link to={`/duel/${d.id}`}>{d.createdBy}'s duel</Link></td>
                  <td className="muted">{formatDate(d.createdAt)}</td>
                  <td><span className={`pill ${d.status}`}>{d.status}</span></td>
                  <td>{d.judgeCalls}</td>
                  <td>{d.appeals}</td>
                  <td><strong>{usd(d.cost)}</strong></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
