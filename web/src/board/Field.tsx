import type { CardView, FieldCardView, PlayerSideView, Seat } from '@yugioh/engine';
import { motion } from 'motion/react';
import type { KeyboardEvent } from 'react';
import { CardFace, dataOf, idOf } from './Card.tsx';
import { useCardHover } from './CardTooltip.tsx';
import { useBoardLook, type CardMarks } from './look.ts';

export interface FieldProps {
  seat: Seat;
  side: PlayerSideView;
  mine: boolean;
  marks: CardMarks;
  /** Opponent's monster zones that may be clicked as attack targets. */
  targetable: number[];
  onCard: (id: string, el: HTMLElement) => void;
  onTarget: (zone: number) => void;
  onPile: (title: string, cards: CardView[]) => void;
}

/**
 * One player's half of the field, laid out like the real playmat: Field Zone and Extra Deck on the left, Graveyard
 * and Deck on the right. The opponent's half is the same mat turned around, so their zones run right to left and
 * each column faces the zone across from it.
 */
export function Field(props: FieldProps) {
  const { seat, side, mine, onPile } = props;
  const order = (zones: (FieldCardView | null)[]) => {
    const indexed = zones.map((z, i) => [z, i] as const);
    return mine ? indexed : indexed.reverse();
  };
  const monsters = order(side.monsters).map(([z, i]) => <Zone key={`m${i}`} row="m" index={i} card={z} {...props} />);
  const spellTraps = order(side.spellTraps).map(([z, i]) => <Zone key={`s${i}`} row="s" index={i} card={z} {...props} />);

  const fieldZone = <div className="zone field-zone"><span className="zone-label">Field</span></div>;
  const gy = (
    <Pile
      label="GY"
      pile={`${seat}:gy`}
      top={side.graveyard.at(-1) ?? null}
      count={side.graveyard.length}
      onOpen={() => onPile(`${side.name}'s Graveyard`, side.graveyard)}
      extra={
        side.banished.length > 0 && (
          <button className="banished-chip" onClick={() => onPile(`${side.name}'s banished cards`, side.banished)}>
            Banished {side.banished.length}
          </button>
        )
      }
    />
  );
  const deck = <Pile label="Deck" pile={`${seat}:deck`} top={side.deckCount > 0 ? { hidden: true } : null} count={side.deckCount} />;
  const extra = (
    <Pile
      label="Extra"
      pile={`${seat}:extra`}
      top={side.extra.length > 0 ? { hidden: true } : null}
      count={side.extra.length}
      onOpen={mine ? () => onPile('Your Extra Deck', side.extra) : undefined}
    />
  );

  return mine ? (
    <div className="field">
      {fieldZone}
      {monsters}
      {gy}
      {extra}
      {spellTraps}
      {deck}
    </div>
  ) : (
    <div className="field">
      {deck}
      {spellTraps}
      {extra}
      {gy}
      {monsters}
      {fieldZone}
    </div>
  );
}

function Zone({ row, index, card, seat, mine, marks, targetable, onCard, onTarget }: FieldProps & { row: 'm' | 's'; index: number; card: FieldCardView | null }) {
  const target = !mine && row === 'm' && targetable.includes(index);
  const label = `${mine ? 'Your' : "Opponent's"} ${row === 'm' ? 'Monster' : 'Spell & Trap'} Zone ${index + 1}`;
  return (
    <div
      className={`zone${target ? ' target' : ''}`}
      aria-label={label}
      onClick={target ? () => onTarget(index) : undefined}
      onKeyDown={target ? (e) => e.key === 'Enter' && onTarget(index) : undefined}
      tabIndex={target ? 0 : undefined}
      role={target ? 'button' : undefined}
    >
      {card && (
        <FieldCard
          view={card}
          slot={`${seat}:${row}:${index}`}
          marks={marks}
          onClick={mine ? onCard : undefined}
        />
      )}
    </div>
  );
}

function FieldCard({ view, slot, marks, onClick }: { view: FieldCardView; slot: string; marks: CardMarks; onClick?: (id: string, el: HTMLElement) => void }) {
  const id = idOf(view.card);
  const data = dataOf(view.card);
  const hover = useCardHover();
  const { imageSize } = useBoardLook();
  const act = onClick && id ? (el: HTMLElement) => onClick(id, el) : undefined;
  return (
    <motion.div
      layout
      layoutId={id ?? undefined}
      className={`slot ${marks.classes(id)}`}
      animate={{ rotate: view.position === 'defense' ? 90 : 0 }}
      {...hover(data)}
      onClick={act ? (e) => act(e.currentTarget) : undefined}
      onKeyDown={act ? (e: KeyboardEvent<HTMLDivElement>) => e.key === 'Enter' && act(e.currentTarget) : undefined}
      tabIndex={act ? 0 : undefined}
      role={act ? 'button' : undefined}
      aria-label={data ? `${data.name}, ${view.faceUp ? '' : 'Set, '}${view.position} position` : 'Face-down card'}
    >
      <div className="fx" data-slot={slot} data-card-id={id ?? undefined}>
        <CardFace card={data} faceDown={!view.faceUp} size={imageSize} />
      </div>
    </motion.div>
  );
}

function Pile({
  label,
  pile,
  top,
  count,
  onOpen,
  extra,
}: {
  label: string;
  pile: string;
  top: CardView | null;
  count: number;
  onOpen?: () => void;
  extra?: React.ReactNode;
}) {
  const hover = useCardHover();
  const { imageSize } = useBoardLook();
  const topId = top ? idOf(top) : null;
  const data = top ? dataOf(top) : null;
  const face = top ? (
    <motion.div layout layoutId={topId ?? undefined} className="fx" data-pile={pile} {...hover(data)}>
      <CardFace card={data} size={imageSize} />
    </motion.div>
  ) : (
    <div className="fx" data-pile={pile} />
  );
  return (
    <div className="zone pile">
      {onOpen ? (
        <button className="plain pile-button" onClick={onOpen} aria-label={`${label}, ${count} cards`}>
          {face}
        </button>
      ) : (
        face
      )}
      <span className="pile-count">
        {label} {count}
      </span>
      {extra}
    </div>
  );
}
