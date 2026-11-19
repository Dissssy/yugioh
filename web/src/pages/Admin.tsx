import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { EffectSheet } from '@yugioh/engine';
import type { AccountStatus, AdminDuels, AdminUser, RulingCard } from '@yugioh/shared';
import { useState } from 'react';
import { api, errorText } from '../api.ts';
import { formatDate } from './Home.tsx';
import { Loading, Notice } from './Notice.tsx';

const order: Record<AccountStatus, number> = { pending: 0, approved: 1, rejected: 2 };

export function Admin() {
  return (
    <>
      <Accounts />
      <Rulings />
      <RecentDuels />
    </>
  );
}

/** Dollars, with more decimals for the small amounts one duel costs. */
const usd = (n: number) => `$${n.toFixed(n < 1 ? 4 : 2)}`;

/**
 * Everyone's latest duels, each with what its judge calls and appeals cost and its full log for review: every card,
 * intent, ruling, appeal and chat message.
 */
function RecentDuels() {
  const duels = useQuery({ queryKey: ['admin', 'duels'], queryFn: () => api<AdminDuels>('/admin/duels') });
  if (!duels.data) return null;
  return (
    <section className="box admin">
      <div className="page-head">
        <h1>Duels</h1>
        <span className="pill">{usd(duels.data.totalCost)} spent on the judge so far</span>
      </div>
      <p className="muted">Costs are estimated from the tokens each judge call and appeal used, at Anthropic's list prices.</p>
      <div className="table-scroll">
        <table>
          <thead>
            <tr><th>Duel</th><th>Created</th><th>Status</th><th>Decks</th><th>Judge calls</th><th>Appeals</th><th>Cost</th><th /></tr>
          </thead>
          <tbody>
            {duels.data.duels.map((duel) => (
              <tr key={duel.id}>
                <td><a href={`/duel/${duel.id}`}><code>{duel.id}</code></a></td>
                <td className="muted">{formatDate(duel.createdAt)}</td>
                <td><span className="pill">{duel.status}</span></td>
                <td className="muted">{duel.createdBy}: {duel.decks[0]} vs {duel.decks[1] ?? '…'}</td>
                <td>{duel.judgeCalls}</td>
                <td>{duel.appeals}</td>
                <td><strong>{usd(duel.cost)}</strong></td>
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

/**
 * Cards whose rulings need a look: players' reports and appeals that overturned a fixed ruling, which set the card's
 * scripts aside for the judge. The admin edits the sheet (restore or verify its scripts, or fix them) and closes the reports.
 */
function Rulings() {
  const cards = useQuery({ queryKey: ['admin', 'rulings'], queryFn: () => api<RulingCard[]>('/admin/rulings') });
  if (!cards.data) return null;
  return (
    <section className="box admin">
      <div className="page-head">
        <h1>Rulings</h1>
        <span className={`pill${cards.data.length ? ' waiting' : ''}`}>{cards.data.length ? `${cards.data.length} cards to look at` : 'Nothing reported'}</span>
      </div>
      {cards.data.map((card) => (
        <RulingEditor key={`${card.code}:${JSON.stringify(card.sheet)}`} card={card} />
      ))}
    </section>
  );
}

/** Sets every scripted effect of a sheet to `status`. */
const withStatus = (sheet: EffectSheet, status: EffectSheet['effects'][number]['status']): EffectSheet => ({
  ...sheet,
  effects: sheet.effects.map((e) => (e.script ? { ...e, status } : e)),
});

function RulingEditor({ card }: { card: RulingCard }) {
  const queryClient = useQueryClient();
  const [text, setText] = useState(() => JSON.stringify(card.sheet, null, 2));
  const [note, setNote] = useState('');
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['admin', 'rulings'] });
  const save = useMutation({
    mutationFn: () => api(`/admin/sheets/${card.code}`, { method: 'POST', body: JSON.stringify({ sheet: JSON.parse(text) as unknown, note }) }),
    onSuccess: () => {
      setNote('');
      return refresh();
    },
  });
  const resolve = useMutation({
    mutationFn: (id: number) => api(`/admin/reports/${id}/resolve`, { method: 'POST' }),
    onSuccess: refresh,
  });
  const setAll = (status: 'unverified' | 'verified') => {
    try {
      setText(JSON.stringify(withStatus(JSON.parse(text) as EffectSheet, status), null, 2));
    } catch {
      // Invalid JSON stays as typed; saving reports it.
    }
  };

  return (
    <div className="ruling">
      <h2>{card.name}</h2>
      <p className="muted">{card.text}</p>
      {card.reports.map((r) => (
        <div key={r.id} className="ruling-report">
          <p>
            <strong>{r.from === 'appeal' ? 'Appeal overturned a fixed ruling' : 'Player report'}</strong>{' '}
            <span className="muted">
              {formatDate(r.createdAt)}, <a href={`/api/admin/duels/${r.matchId}/report`} target="_blank" rel="noreferrer">duel log</a> at event {r.seq}
            </span>
          </p>
          <p>{r.note}</p>
          <button className="quiet" disabled={resolve.isPending} onClick={() => resolve.mutate(r.id)}>
            Close report
          </button>
        </div>
      ))}
      {card.sheet ? (
        <>
          <textarea className="sheet-json" rows={16} value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} />
          <div className="cell-actions">
            <button className="quiet" onClick={() => setAll('unverified')}>Restore scripts</button>
            <button className="quiet" onClick={() => setAll('verified')}>Mark scripts verified</button>
          </div>
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="What changed and why" maxLength={1000} />
          {save.isError && <p className="error">{save.error instanceof SyntaxError ? 'The sheet is not valid JSON.' : errorText(save.error)}</p>}
          <button className="primary" disabled={!note.trim() || save.isPending} onClick={() => save.mutate()}>
            Save sheet
          </button>
        </>
      ) : (
        <p className="muted">This card has no effect sheet.</p>
      )}
    </div>
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
