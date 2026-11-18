import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AccountStatus, User } from '@yugioh/shared';
import { api } from '../api.ts';
import { formatDate } from './Home.tsx';

const order: Record<AccountStatus, number> = { pending: 0, approved: 1, rejected: 2 };

export function Admin() {
  const queryClient = useQueryClient();
  const users = useQuery({ queryKey: ['admin', 'users'], queryFn: () => api<User[]>('/admin/users') });
  const setStatus = useMutation({
    mutationFn: ({ id, status }: { id: number; status: AccountStatus }) =>
      api<User>(`/admin/users/${id}/status`, { method: 'POST', body: JSON.stringify({ status }) }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin', 'users'] }),
  });

  if (users.isError) return <p className="error">Only the admin can see this page.</p>;
  if (!users.data) return <p>Loading…</p>;

  const sorted = [...users.data].sort((a, b) => order[a.status] - order[b.status]);
  return (
    <section>
      <h1>Accounts</h1>
      <table>
        <thead>
          <tr><th>Name</th><th>Email</th><th>Signed up</th><th>Status</th><th /></tr>
        </thead>
        <tbody>
          {sorted.map((user) => (
            <tr key={user.id}>
              <td>{user.name}</td>
              <td>{user.email}</td>
              <td>{formatDate(user.createdAt)}</td>
              <td className={`status ${user.status}`}>{user.isAdmin ? 'admin' : user.status}</td>
              <td>
                {!user.isAdmin &&
                  (['approved', 'rejected'] as const)
                    .filter((s) => s !== user.status)
                    .map((status) => (
                      <button key={status} onClick={() => setStatus.mutate({ id: user.id, status })}>
                        {status === 'approved' ? 'Approve' : 'Reject'}
                      </button>
                    ))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
