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
  /** Whether a zone can be picked now ('open'), and whether a dragged card or aimed arrow is over it ('over'). */
  zoneState: (row: Row, index: number) => 'open' | 'over' | null;
  onZone: (row: Row, index: number, el: HTMLElement) => void;
  onCard: (id: string, el: HTMLElement) => void;
  /** A press on one of your monsters, which may become an aimed attack. */
  onCardPress?: (id: string, e: React.PointerEvent<HTMLElement>) => void;
  onPile: (title: string, cards: CardView[]) => void;
}

export type Row = 'm' | 's';

/** The drop key of a zone, matched against `data-drop` under the pointer. */
export const dropKey = (seat: Seat, row: Row, index: number) => `${seat}:${row}:${index}`;

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

function Zone({ row, index, card, seat, mine, marks, zoneState, onZone, onCard, onCardPress }: FieldProps & { row: Row; index: number; card: FieldCardView | null }) {
  const state = zoneState(row, index);
  const label = `${mine ? 'Your' : "Opponent's"} ${row === 'm' ? 'Monster' : 'Spell & Trap'} Zone ${index + 1}`;
  const pick = state
    ? (e: React.SyntheticEvent<HTMLElement>) => {
        e.stopPropagation();
        onZone(row, index, e.currentTarget);
      }
    : undefined;
  return (
    <div
      className={`zone${state ? ` open${mine ? '' : ' foe'}` : ''}${state === 'over' ? ' over' : ''}`}
      data-drop={dropKey(seat, row, index)}
      aria-label={label}
      onClickCapture={pick}
      onKeyDown={pick ? (e) => e.key === 'Enter' && pick(e) : undefined}
      tabIndex={pick ? 0 : undefined}
      role={pick ? 'button' : undefined}
    >
      {card && (
        <FieldCard
          view={card}
          slot={dropKey(seat, row, index)}
          marks={marks}
          onClick={mine ? onCard : undefined}
          onPress={mine ? onCardPress : undefined}
        />
      )}
      {card && <StatsBadge view={card} />}
    </div>
  );
}

/** A face-up monster's ATK and DEF when an effect has changed them, green when raised and red when lowered. */
function StatsBadge({ view }: { view: FieldCardView }) {
  const printed = dataOf(view.card);
  if (!view.stats || !printed || (view.stats.atk === printed.atk && view.stats.def === printed.def)) return null;
  const tone = (now: number, was: number | null) => (was === null || now === was ? '' : now > was ? 'up' : 'down');
  return (
    <span className="stats-badge" aria-label={`ATK ${view.stats.atk}, DEF ${view.stats.def}`}>
      <span className={tone(view.stats.atk, printed.atk)}>{view.stats.atk}</span> / <span className={tone(view.stats.def, printed.def)}>{view.stats.def}</span>
    </span>
  );
}

function FieldCard({
  view,
  slot,
  marks,
  onClick,
  onPress,
}: {
  view: FieldCardView;
  slot: string;
  marks: CardMarks;
  onClick?: (id: string, el: HTMLElement) => void;
  onPress?: (id: string, e: React.PointerEvent<HTMLElement>) => void;
}) {
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
      onPointerDown={onPress && id ? (e) => onPress(id, e) : undefined}
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
