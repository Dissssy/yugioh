import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { EffectSheet } from '@yugioh/engine';
import { isAdmin, type AccountStatus, type AdminDuels, type AdminUser, type ApiKey, type DiscordServer, type Me, type ReviewRequest, type ReviewStatus, type Role, type RulingCard, type Rulings } from '@yugioh/shared';
import { useState } from 'react';
import { Link } from 'react-router';
import { api, errorText } from '../api.ts';
import { formatDate } from './Home.tsx';
import { Loading, Notice } from './Notice.tsx';

const order: Record<AccountStatus, number> = { pending: 0, approved: 1, rejected: 2 };

const roleName: Record<Role, string> = { player: 'player', admin: 'admin', superAdmin: 'super admin' };

export function Admin({ me }: { me: Me }) {
  if (me.kind !== 'user' || !isAdmin(me.user.role)) return <Notice title="Admins only" tone="error">Only admins can see this page.</Notice>;
  return (
    <>
      <Accounts superAdmin={me.user.role === 'superAdmin'} />
      <DiscordServers />
      <Reviews />
      <RulingsSection />
      <RecentDuels />
      {me.user.role === 'superAdmin' && <ApiKeys />}
    </>
  );
}

/** A section that couldn't load says so, with the server's reason, instead of vanishing. */
function Failed({ what, error }: { what: string; error: Error }) {
  return (
    <Notice title={`Couldn't load the ${what}`} tone="error">
      {errorText(error)}
    </Notice>
  );
}

/** Dollars, with more decimals for the small amounts one duel costs. */
const usd = (n: number) => `$${n.toFixed(n < 1 ? 4 : 2)}`;

/**
 * Everyone's latest duels, each with what its judge calls, appeals and AI opponent calls cost and its full log for review: every card,
 * intent, ruling, appeal and chat message.
 */
function RecentDuels() {
  const duels = useQuery({ queryKey: ['admin', 'duels'], queryFn: () => api<AdminDuels>('/admin/duels') });
  const [sending, setSending] = useState<string | null>(null);
  if (duels.isError) return <Failed what="duels" error={duels.error} />;
  if (!duels.data) return null;
  return (
    <section className="box admin">
      <div className="page-head">
        <h1>Duels</h1>
        <span className="pill">{usd(duels.data.totalCost)} spent on models so far</span>
      </div>
      <p className="muted">Costs are estimated from the tokens each judge call, appeal, question to the judge and AI opponent call used, at Anthropic's list prices.</p>
      <div className="table-scroll">
        <table>
          <thead>
            <tr><th>Duel</th><th>Created</th><th>Status</th><th>Players</th><th>Judge calls</th><th>Appeals</th><th>Questions</th><th>AI calls</th><th>Cost</th><th /></tr>
          </thead>
          <tbody>
            {duels.data.duels.map((duel) => (
              <tr key={duel.id}>
                <td><a href={`/duel/${duel.id}`}><code>{duel.id}</code></a></td>
                <td className="muted">{formatDate(duel.createdAt)}</td>
                <td><span className="pill">{duel.status}</span></td>
                <td className="muted">{duel.players.map((p) => (p ? `${p.name} (${p.deck ?? 'choosing'})` : 'open seat')).join(' vs ')}</td>
                <td>{duel.judgeCalls}</td>
                <td>{duel.appeals}</td>
                <td>{duel.questions}</td>
                <td>{duel.aiCalls}</td>
                <td><strong>{usd(duel.cost)}</strong></td>
                <td className="cell-actions">
                  {duel.status === 'finished' && <Link to={`/duel/${duel.id}/replay`}>Replay</Link>}{' '}
                  <a href={`/api/admin/duels/${duel.id}/report`} target="_blank" rel="noreferrer">Full log</a>{' '}
                  <a href={`/api/admin/duels/${duel.id}/report?format=json`} target="_blank" rel="noreferrer">JSON</a>{' '}
                  <button className="quiet" onClick={() => setSending(sending === duel.id ? null : duel.id)}>Send to Claude</button>
                  {sending === duel.id && <SendForm matchId={duel.id} onSent={() => setSending(null)} />}
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
function RulingsSection() {
  const queryClient = useQueryClient();
  const rulings = useQuery({ queryKey: ['admin', 'rulings'], queryFn: () => api<Rulings>('/admin/rulings') });
  const resolve = useMutation({
    mutationFn: (id: number) => api(`/admin/reports/${id}/resolve`, { method: 'POST' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin', 'rulings'] }),
  });
  if (rulings.isError) return <Failed what="rulings" error={rulings.error} />;
  if (!rulings.data) return null;
  const { cards, engine } = rulings.data;
  const count = cards.length + engine.length;
  return (
    <section className="box admin">
      <div className="page-head">
        <h1>Rulings</h1>
        <span className={`pill${count ? ' waiting' : ''}`}>{count ? `${count} to look at` : 'Nothing reported'}</span>
      </div>
      {engine.length > 0 && (
        <div className="ruling">
          <h2>Rules in code</h2>
          <p className="muted">Escalated questions where the appeal found a generic rule in code wrong. Nothing changed in the duel.</p>
          {engine.map((r) => (
            <div key={r.id} className="ruling-report">
              <p>
                <strong>Escalated question</strong>{' '}
                <span className="muted">
                  {formatDate(r.createdAt)}, <a href={`/api/admin/duels/${r.matchId}/report`} target="_blank" rel="noreferrer">duel log</a> at event {r.seq}
                </span>
              </p>
              <p>{r.note}</p>
              <button className="quiet" disabled={resolve.isPending} onClick={() => resolve.mutate(r.id)}>
                Close report
              </button>{' '}
              <SendReport matchId={r.matchId} seq={r.seq} code={null} note={`Escalated question found a rule in code wrong: ${r.note}`} />
            </div>
          ))}
        </div>
      )}
      {cards.map((card) => (
        <RulingEditor key={`${card.code}:${JSON.stringify(card.sheet)}`} card={card} />
      ))}
    </section>
  );
}

const REPORT_FROM = { appeal: 'Appeal overturned a fixed ruling', escalation: 'Escalated question found the card wrong', player: 'Player report' };

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
            <strong>{REPORT_FROM[r.from]}</strong>{' '}
            <span className="muted">
              {formatDate(r.createdAt)}, <a href={`/api/admin/duels/${r.matchId}/report`} target="_blank" rel="noreferrer">duel log</a> at event {r.seq}
            </span>
          </p>
          <p>{r.note}</p>
          <button className="quiet" disabled={resolve.isPending} onClick={() => resolve.mutate(r.id)}>
            Close report
          </button>{' '}
          <SendReport matchId={r.matchId} seq={r.seq} code={card.code} note={`${REPORT_FROM[r.from]}: ${r.note}`} />
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

/**
 * The Discord servers the Activity was opened in. Whoever opens it in a trusted one is approved automatically; anywhere
 * else they wait here like a website signup. Hidden until the Activity has been opened in a server.
 */
function DiscordServers() {
  const queryClient = useQueryClient();
  const servers = useQuery({ queryKey: ['admin', 'discord-servers'], queryFn: () => api<DiscordServer[]>('/admin/discord-servers') });
  const setTrusted = useMutation({
    mutationFn: ({ id, trusted }: { id: string; trusted: boolean }) =>
      api(`/admin/discord-servers/${id}`, { method: 'POST', body: JSON.stringify({ trusted }) }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin', 'discord-servers'] }),
  });

  if (servers.isError) return <Failed what="Discord servers" error={servers.error} />;
  if (!servers.data?.length) return null;
  return (
    <section className="box admin">
      <div className="page-head">
        <h1>Discord servers</h1>
      </div>
      <p className="muted small">
        Everyone who opens the Activity in a trusted server is approved automatically. Elsewhere, new players wait for
        approval above. Discord doesn't tell the site a server's name, so who opened it last shows which one it is.
      </p>
      {setTrusted.error && <p className="error">{errorText(setTrusted.error)}</p>}
      <div className="table-scroll">
        <table>
          <thead>
            <tr><th>Server</th><th>Last opened</th><th>Approve players</th></tr>
          </thead>
          <tbody>
            {servers.data.map((server) => (
              <tr key={server.id}>
                <td>{server.id}</td>
                <td className="muted">
                  {formatDate(server.lastOpenedAt)}
                  {server.lastOpenedBy && <div className="small">by {server.lastOpenedBy}</div>}
                </td>
                <td>
                  <label>
                    <input
                      type="checkbox"
                      checked={server.trusted}
                      disabled={setTrusted.isPending}
                      onChange={(e) => setTrusted.mutate({ id: server.id, trusted: e.target.checked })}
                    />{' '}
                    Trusted
                  </label>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** Accounts waiting for approval and everyone else. Admins approve and reject players; the super admin also makes admins. */
function Accounts({ superAdmin }: { superAdmin: boolean }) {
  const queryClient = useQueryClient();
  const users = useQuery({ queryKey: ['admin', 'users'], queryFn: () => api<AdminUser[]>('/admin/users') });
  const onSuccess = () => queryClient.invalidateQueries({ queryKey: ['admin', 'users'] });
  const setStatus = useMutation({
    mutationFn: ({ id, status }: { id: number; status: AccountStatus }) =>
      api<AdminUser>(`/admin/users/${id}/status`, { method: 'POST', body: JSON.stringify({ status }) }),
    onSuccess,
  });
  const setRole = useMutation({
    mutationFn: ({ id, role }: { id: number; role: Exclude<Role, 'superAdmin'> }) =>
      api<AdminUser>(`/admin/users/${id}/role`, { method: 'POST', body: JSON.stringify({ role }) }),
    onSuccess,
  });
  const busy = setStatus.isPending || setRole.isPending;
  const failed = setStatus.error ?? setRole.error;

  if (users.isError) return <Failed what="accounts" error={users.error} />;
  if (!users.data) return <Loading />;

  const sorted = [...users.data].sort((a, b) => order[a.status] - order[b.status]);
  const pending = sorted.filter((u) => u.status === 'pending').length;
  return (
    <section className="box admin">
      <div className="page-head">
        <h1>Accounts</h1>
        <span className={`pill${pending ? ' waiting' : ''}`}>{pending ? `${pending} waiting for approval` : 'No one waiting'}</span>
      </div>
      {failed && <p className="error">{errorText(failed)}</p>}
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
                <td>
                  <span className={`pill ${isAdmin(user.role) ? 'admin' : user.status}`}>{isAdmin(user.role) ? roleName[user.role] : user.status}</span>
                </td>
                <td className="cell-actions">
                  {user.role === 'player' &&
                    (['approved', 'rejected'] as const)
                      .filter((s) => s !== user.status)
                      .map((status) => (
                        <button
                          key={status}
                          className={status === 'approved' ? 'primary' : 'quiet'}
                          disabled={busy}
                          onClick={() => setStatus.mutate({ id: user.id, status })}
                        >
                          {status === 'approved' ? 'Approve' : 'Reject'}
                        </button>
                      ))}
                  {superAdmin && user.status === 'approved' && user.role !== 'superAdmin' && (
                    <button
                      className="quiet"
                      disabled={busy}
                      onClick={() => setRole.mutate({ id: user.id, role: user.role === 'admin' ? 'player' : 'admin' })}
                    >
                      {user.role === 'admin' ? 'Remove admin' : 'Make admin'}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

type NewReview = { matchId: string; seq: number | null; code: number | null; note: string };

function useSendReview() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (review: NewReview) => api<ReviewRequest>('/admin/reviews', { method: 'POST', body: JSON.stringify(review) }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin', 'reviews'] }),
  });
}

/** Sends a duel to Claude: a log entry (the `#` number in the Full log) if it is about one moment, and what looks wrong. */
function SendForm({ matchId, onSent }: { matchId: string; onSent: () => void }) {
  const send = useSendReview();
  const [seq, setSeq] = useState('');
  const [note, setNote] = useState('');
  return (
    <form
      className="send-review"
      onSubmit={(e) => {
        e.preventDefault();
        send.mutate({ matchId, seq: seq ? Number(seq) : null, code: null, note }, { onSuccess: onSent });
      }}
    >
      <input value={seq} onChange={(e) => setSeq(e.target.value.replace(/\D/g, ''))} placeholder="Log entry #, or blank for the whole duel" inputMode="numeric" />
      <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="What looks wrong (e.g. Pot of Greed was never offered)" maxLength={2000} />
      {send.isError && <p className="error">{errorText(send.error)}</p>}
      <button className="primary" disabled={!note.trim() || send.isPending}>Send</button>
    </form>
  );
}

/** Sends a report on to Claude as it stands. */
function SendReport(review: NewReview) {
  const send = useSendReview();
  if (send.isSuccess) return <span className="muted small">Sent to Claude</span>;
  return (
    <>
      <button className="quiet" disabled={send.isPending} onClick={() => send.mutate(review)}>Send to Claude</button>
      {send.isError && <span className="error">{errorText(send.error)}</span>}
    </>
  );
}

const REVIEW_STATUS: Record<ReviewStatus, string> = { open: 'waiting for Claude', claimed: 'Claude is on it', fixed: 'fixed', wont_fix: "won't fix" };

/** What admins sent to Claude, and what came of it (docs/review-api.md). */
function Reviews() {
  const reviews = useQuery({ queryKey: ['admin', 'reviews'], queryFn: () => api<ReviewRequest[]>('/admin/reviews') });
  if (reviews.isError) return <Failed what="review requests" error={reviews.error} />;
  if (!reviews.data?.length) return null;
  const waiting = reviews.data.filter((r) => r.status === 'open' || r.status === 'claimed').length;
  return (
    <section className="box admin">
      <div className="page-head">
        <h1>Sent to Claude</h1>
        <span className={`pill${waiting ? ' waiting' : ''}`}>{waiting ? `${waiting} in progress` : 'All done'}</span>
      </div>
      <p className="muted small">A Claude thread checks for new requests every hour, fixes what it can in a pull request, and reports back here.</p>
      {reviews.data.map((r) => (
        <div key={r.id} className="ruling-report">
          <p>
            <span className="pill">{REVIEW_STATUS[r.status]}</span>{' '}
            <span className="muted">
              {formatDate(r.createdAt)} by {r.sentBy},{' '}
              <a href={`/api/admin/duels/${r.matchId}/report`} target="_blank" rel="noreferrer">duel log</a>
              {r.seq !== null && ` at #${r.seq}`}
              {r.cardName && `, ${r.cardName}`}
            </span>
          </p>
          <p>{r.note}</p>
          {r.result && <p className="muted">{r.result}</p>}
          {r.prUrl && <p><a href={r.prUrl} target="_blank" rel="noreferrer">{r.prUrl}</a></p>}
        </div>
      ))}
    </section>
  );
}

/** Admin API keys, for tools such as the Claude thread that works the review queue. The super admin's alone. */
function ApiKeys() {
  const queryClient = useQueryClient();
  const keys = useQuery({ queryKey: ['admin', 'keys'], queryFn: () => api<ApiKey[]>('/admin/keys') });
  const [name, setName] = useState('');
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['admin', 'keys'] });
  const create = useMutation({
    mutationFn: () => api<{ id: number; key: string }>('/admin/keys', { method: 'POST', body: JSON.stringify({ name }) }),
    onSuccess: () => {
      setName('');
      return refresh();
    },
  });
  const revoke = useMutation({ mutationFn: (id: number) => api(`/admin/keys/${id}`, { method: 'DELETE' }), onSuccess: refresh });
  if (keys.isError) return <Failed what="API keys" error={keys.error} />;
  if (!keys.data) return null;
  return (
    <section className="box admin">
      <div className="page-head">
        <h1>API keys</h1>
      </div>
      <p className="muted small">
        A key works on the admin API as an admin (reading duel logs, editing rulings, working review requests), never as
        the super admin. Send it as <code>Authorization: Bearer &lt;key&gt;</code>.
      </p>
      {create.data && (
        <p>
          New key, shown only this once: <code>{create.data.key}</code>
        </p>
      )}
      {(create.error ?? revoke.error) && <p className="error">{errorText((create.error ?? revoke.error)!)}</p>}
      {keys.data.length > 0 && (
        <div className="table-scroll">
          <table>
            <thead>
              <tr><th>Name</th><th>Made by</th><th>Made</th><th>Last used</th><th /></tr>
            </thead>
            <tbody>
              {keys.data.map((k) => (
                <tr key={k.id}>
                  <td><strong>{k.name}</strong></td>
                  <td className="muted">{k.createdBy}</td>
                  <td className="muted">{formatDate(k.createdAt)}</td>
                  <td className="muted">{k.lastUsedAt ? formatDate(k.lastUsedAt) : 'never'}</td>
                  <td className="cell-actions">
                    <button className="quiet" disabled={revoke.isPending} onClick={() => revoke.mutate(k.id)}>Revoke</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <form
        className="send-review"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="What the key is for" maxLength={100} />
        <button className="primary" disabled={!name.trim() || create.isPending}>Make a key</button>
      </form>
    </section>
  );
}
