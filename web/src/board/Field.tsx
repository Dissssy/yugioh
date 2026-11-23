import { FIELD_ZONE, MONSTER_ZONES, SPELL_TRAP_ZONES, type CardView, type FieldCardView, type PlayerSideView, type Seat } from '@yugioh/engine';
import { motion } from 'motion/react';
import { CardFace, dataOf, idOf } from './Card.tsx';
import { useCardHover } from './CardTooltip.tsx';
import { pileKey, useChoice, type PileKind } from './choice.tsx';
import { useBoardLook, type CardMarks } from './look.ts';

export interface FieldProps {
  seat: Seat;
  side: PlayerSideView;
  mine: boolean;
  /** Whether this half's cards point away from the viewer, as the opponent's do across a real table. */
  turned?: boolean;
  marks: CardMarks;
  /** Whether a zone can be picked now ('open'), and whether a dragged card or aimed arrow is over it ('over'). */
  zoneState: (row: Row, index: number) => 'open' | 'over' | null;
  onZone: (row: Row, index: number, el: HTMLElement) => void;
  onCard: (id: string, el: HTMLElement) => void;
  /** A press on one of your monsters, which may become an aimed attack. */
  onCardPress?: (id: string, e: React.PointerEvent<HTMLElement>) => void;
  /** Opens a pile's viewer. */
  onPile: (place: PileKind) => void;
  /** Whether a card in your Extra Deck can be Summoned now, which makes the pile glow. */
  extraPlayable?: boolean;
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
  const { seat, side, mine, turned, onPile, extraPlayable } = props;
  const order = (zones: (FieldCardView | null)[]) => {
    const indexed = zones.map((z, i) => [z, i] as const);
    return mine ? indexed : indexed.reverse();
  };
  const monsters = order(side.monsters.slice(0, MONSTER_ZONES)).map(([z, i]) => <Zone key={`m${i}`} row="m" index={i} card={z} {...props} />);
  const spellTraps = order(side.spellTraps.slice(0, SPELL_TRAP_ZONES)).map(([z, i]) => <Zone key={`s${i}`} row="s" index={i} card={z} {...props} />);

  const fieldZone = <Zone row="s" index={FIELD_ZONE} card={side.spellTraps[FIELD_ZONE] ?? null} {...props} />;
  const choice = useChoice();
  const options = (place: PileKind) => choice?.inPile(pileKey(seat, place)).length ?? 0;
  const gy = (
    <Pile
      label="GY"
      pile={`${seat}:gy`}
      top={side.graveyard.at(-1) ?? null}
      count={side.graveyard.length}
      options={options('graveyard')}
      onOpen={() => onPile('graveyard')}
      extra={
        side.banished.length > 0 && (
          <button
            className={`banished-chip${options('banished') > 0 ? ' pickable' : ''}`}
            onClick={() => onPile('banished')}
            tabIndex={-1}
            data-nav={`${seat}:banished`}
            data-pick={options('banished') > 0 ? '' : undefined}
          >
            Banished {side.banished.length}
          </button>
        )
      }
    />
  );
  // Your Deck opens only to pick from it, and then shows just the cards you may pick.
  const deckOptions = options('deck');
  const deck = (
    <Pile
      label="Deck"
      pile={`${seat}:deck`}
      top={side.deckCount > 0 ? { hidden: true } : null}
      count={side.deckCount}
      options={deckOptions}
      onOpen={deckOptions > 0 ? () => onPile('deck') : undefined}
    />
  );
  const extra = (
    <Pile
      label="Extra"
      pile={`${seat}:extra`}
      top={side.extra.length > 0 ? { hidden: true } : null}
      count={side.extra.length}
      options={options('extra')}
      playable={extraPlayable}
      onOpen={mine ? () => onPile('extra') : undefined}
    />
  );

  return mine ? (
    <div className={`playmat${turned ? ' turned' : ''}`}>
      {fieldZone}
      {monsters}
      {gy}
      {extra}
      {spellTraps}
      {deck}
    </div>
  ) : (
    <div className={`playmat${turned ? ' turned' : ''}`}>
      {deck}
      {spellTraps}
      {extra}
      {gy}
      {monsters}
      {fieldZone}
    </div>
  );
}

/**
 * The two Extra Monster Zones, in the middle of the table between both fields. Each is shared: it shows whichever
 * player's monster is in it, and is the viewer's own while empty. The left one, as the viewer sees it, is the viewer's
 * zone 5 and the opponent's zone 6.
 */
export function ExtraMonsterZone({ side, mine, foe }: { side: 'left' | 'right'; mine: FieldProps; foe: FieldProps }) {
  const foeIndex = side === 'left' ? 6 : 5;
  const props = foe.side.monsters[foeIndex] ? foe : mine;
  const index = props === foe ? foeIndex : side === 'left' ? 5 : 6;
  return <Zone row="m" index={index} card={props.side.monsters[index] ?? null} {...props} />;
}

function Zone({ row, index, card, seat, mine, turned, marks, zoneState, onZone, onCard, onCardPress }: FieldProps & { row: Row; index: number; card: FieldCardView | null }) {
  const state = zoneState(row, index);
  const extra = row === 'm' && index >= MONSTER_ZONES;
  const label = extra
    ? `Extra Monster Zone${card ? (mine ? ', yours' : ", your opponent's") : ''}`
    : row === 's' && index === FIELD_ZONE
      ? `${mine ? 'Your' : "Opponent's"} Field Zone`
      : `${mine ? 'Your' : "Opponent's"} ${row === 'm' ? 'Monster' : 'Spell & Trap'} Zone ${index + 1}`;
  const pick = state
    ? (e: React.SyntheticEvent<HTMLElement>) => {
        e.stopPropagation();
        onZone(row, index, e.currentTarget);
      }
    : undefined;
  return (
    <div
      className={`zone${extra ? ' extra-zone' : ''}${row === 's' && index === FIELD_ZONE ? ' field-zone' : ''}${extra && turned && !mine ? ' turned' : ''}${state ? ` open${mine ? '' : ' foe'}` : ''}${state === 'over' ? ' over' : ''}`}
      data-drop={dropKey(seat, row, index)}
      // An empty zone is a place to focus only while a card may go there; a card covers the zone it's in.
      data-nav={pick && !card ? dropKey(seat, row, index) : undefined}
      data-pick={pick && !card ? '' : undefined}
      aria-label={label}
      onClickCapture={pick}
      tabIndex={pick && !card ? -1 : undefined}
      role={pick ? 'button' : undefined}
    >
      {card && card.materials.length > 0 && <Materials cards={card.materials} />}
      {card && card.spellCounters > 0 && (
        <span className="counters-chip" aria-label={`${card.spellCounters} Spell Counter${card.spellCounters === 1 ? '' : 's'}`} title="Spell Counters">
          {card.spellCounters}
        </span>
      )}
      {card && (
        <FieldCard
          view={card}
          slot={dropKey(seat, row, index)}
          marks={marks}
          target={state !== null}
          onClick={mine ? onCard : undefined}
          onPress={mine ? onCardPress : undefined}
        />
      )}
      {card && <StatsBadge view={card} />}
      {!card && row === 's' && index === FIELD_ZONE && <span className="zone-label">Field</span>}
    </div>
  );
}

/**
 * An Xyz Monster's materials, tucked under it with their edges showing, and a count. While a question offers them,
 * they fan out so each can be picked.
 */
function Materials({ cards }: { cards: CardView[] }) {
  const hover = useCardHover();
  const { imageSize } = useBoardLook();
  const choice = useChoice();
  const fanned = cards.some((c) => choice?.state(idOf(c)) != null);
  return (
    <>
      {cards.map((c, i) => {
        const id = idOf(c);
        const picking = choice?.state(id) ?? null;
        const pick = picking ? () => choice!.toggle(id) : undefined;
        const step = fanned ? `calc(${i + 1} * var(--card-w) * 0.55)` : `${(i + 1) * 5}px`;
        const data = dataOf(c);
        return (
          <motion.div
            key={id ?? i}
            layout
            layoutId={id ?? undefined}
            className={`slot material ${picking ?? ''}`}
            style={{ translate: `calc(-1 * ${step}) calc(-1 * ${fanned ? '0px' : step})`, zIndex: -1 - i }}
            {...hover(data)}
            onClick={pick}
            data-nav={pick && id ? `material:${id}` : undefined}
            data-pick={pick ? '' : undefined}
            tabIndex={pick ? -1 : undefined}
            role={pick ? 'button' : undefined}
            aria-label={`Xyz Material: ${data?.name ?? 'a card'}`}
            aria-pressed={picking ? picking === 'picked' : undefined}
          >
            <div className="fx" data-card-id={id ?? undefined}>
              <CardFace card={data} size={imageSize} />
            </div>
          </motion.div>
        );
      })}
      <span className="materials-chip" aria-label={`${cards.length} Xyz Material${cards.length === 1 ? '' : 's'}`}>
        {cards.length}
      </span>
    </>
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
  target,
  onClick,
  onPress,
}: {
  view: FieldCardView;
  slot: string;
  marks: CardMarks;
  /** Its zone may be picked now (an attack target, say): picking the card picks the zone. */
  target: boolean;
  onClick?: (id: string, el: HTMLElement) => void;
  onPress?: (id: string, e: React.PointerEvent<HTMLElement>) => void;
}) {
  const id = idOf(view.card);
  const data = dataOf(view.card);
  const hover = useCardHover();
  const { imageSize } = useBoardLook();
  // While the judge asks for cards, clicking one it offers picks it, even an opponent's.
  const choice = useChoice();
  const picking = choice?.state(id, slot) ?? null;
  const act = picking ? () => choice!.toggle(id, slot) : onClick && id ? (el: HTMLElement) => onClick(id, el) : undefined;
  return (
    <motion.div
      layout
      layoutId={id ?? undefined}
      className={`slot ${marks.classes(id)} ${picking ?? ''}`}
      animate={{ rotate: view.position === 'defense' ? 90 : 0 }}
      {...hover(data, view.stats)}
      onPointerDown={onPress && id ? (e) => onPress(id, e) : undefined}
      onClick={act ? (e) => act(e.currentTarget) : undefined}
      data-nav={slot}
      data-pick={picking || target || marks.pickable(id) ? '' : undefined}
      tabIndex={-1}
      role={act || target ? 'button' : undefined}
      aria-label={data ? `${data.name}, ${view.faceUp ? '' : 'Set, '}${view.position} position` : 'Face-down card'}
      aria-pressed={picking ? picking === 'picked' : undefined}
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
  options,
  playable,
  onOpen,
  extra,
}: {
  label: string;
  pile: string;
  top: CardView | null;
  count: number;
  /** How many of the cards the judge offers are in this pile. */
  options: number;
  playable?: boolean;
  onOpen?: () => void;
  extra?: React.ReactNode;
}) {
  const hover = useCardHover();
  const { imageSize } = useBoardLook();
  const topId = top ? idOf(top) : null;
  const nav = { 'data-nav': pile, 'data-pick': options > 0 ? '' : undefined };
  const data = top ? dataOf(top) : null;
  const face = top ? (
    <motion.div layout layoutId={topId ?? undefined} className="fx" data-pile={pile} {...hover(data)}>
      <CardFace card={data} size={imageSize} />
    </motion.div>
  ) : (
    <div className="fx" data-pile={pile} />
  );
  return (
    <div className={`zone pile${options > 0 ? ' pickable' : ''}${playable ? ' playable' : ''}`}>
      {onOpen ? (
        <button className="plain pile-button" onClick={onOpen} tabIndex={-1} {...nav} aria-label={`${label}, ${count} cards${options > 0 ? `, ${options} to choose from` : ''}`}>
          {face}
        </button>
      ) : (
        face
      )}
      <span className="pile-count">
        {label} {count}
      </span>
      {options > 0 && <span className="pile-options">{options} to choose</span>}
      {extra}
    </div>
  );
}
