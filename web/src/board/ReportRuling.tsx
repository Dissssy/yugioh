import { useMutation } from '@tanstack/react-query';
import type { CardData } from '@yugioh/engine';
import { useState } from 'react';
import { api, errorText } from '../api.ts';

/**
 * Under a pinned card's details: tell the admin how this card is ruled wrongly. Any fixed rulings it had are set
 * aside at once, so the judge rules on it from then on.
 */
export function ReportRuling({ duelId, card }: { duelId: string; card: CardData }) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const report = useMutation({
    mutationFn: () => api(`/duels/${duelId}/report`, { method: 'POST', body: JSON.stringify({ code: card.code, note }) }),
  });

  if (report.isSuccess) return <p className="report-ruling muted">Thanks. The judge rules on this card from now on, and the admin will look at your report.</p>;
  if (!open) {
    return (
      <button className="quiet report-ruling" onClick={() => setOpen(true)}>
        Report a ruling problem
      </button>
    );
  }
  return (
    <form
      className="report-ruling"
      onSubmit={(e) => {
        e.preventDefault();
        report.mutate();
      }}
    >
      <textarea
        autoFocus
        rows={3}
        maxLength={1000}
        value={note}
        onChange={(e) => setNote(e.target.value)}
        onKeyDown={(e) => e.stopPropagation()}
        placeholder="What did the game do with this card, and what should it have done?"
      />
      {report.isError && <p className="error">{errorText(report.error)}</p>}
      <div className="report-actions">
        <button type="button" className="quiet" onClick={() => setOpen(false)}>
          Cancel
        </button>
        <button className="primary" disabled={!note.trim() || report.isPending}>
          Send report
        </button>
      </div>
    </form>
  );
}
