import { useMutation } from '@tanstack/react-query';
import type { CardData, CardView, FieldCardView, Intent, LegalAction, Phase, PlayerSideView, PlayerView, Seat } from '@yugioh/engine';
import { motion } from 'motion/react';
import { useEffect, useState } from 'react';
import { api, errorText } from '../api.ts';
import { CardFace, dataOf, idOf } from './Card.tsx';
import { CardDetail } from './CardDetail.tsx';

/** The seat's live view of the duel, pushed by the server. The browser reconnects by itself if the stream drops. */
function useDuelView(duelId: string) {
  const [view, setView] = useState<PlayerView | null>(null);
  const [connected, setConnected] = useState(true);
  useEffect(() => {
    const source = new EventSource(`/api/duels/${duelId}/stream`);
    source.onmessage = (e: MessageEvent<string>) => {
      setView(JSON.parse(e.data) as PlayerView);
      setConnected(true);
    };
    source.onerror = () => setConnected(false);
    return () => source.close();
  }, [duelId]);
  return { view, connected };
}

/** A choice the player is in the middle of making on the board. */
type Choosing =
  | { kind: 'tributes'; action: Extract<LegalAction, { type: 'normalSummon' | 'setMonster' }>; chosen: string[] }
  | { kind: 'target'; action: Extract<LegalAction, { type: 'attack' }> }
  | { kind: 'discard'; count: number; chosen: string[] };

const phaseNames: Record<Phase, string> = {
  draw: 'Draw Phase',
  standby: 'Standby Phase',
  main1: 'Main Phase 1',
  battle: 'Battle Phase',
  main2: 'Main Phase 2',
  end: 'End Phase',
};

export function Board({ duelId }: { duelId: string }) {
  const { view, connected } = useDuelView(duelId);
  const [selected, setSelected] = useState<string | null>(null);
  const [choosing, setChoosing] = useState<Choosing | null>(null);
  const [inspected, setInspected] = useState<CardData | null>(null);
  const [pile, setPile] = useState<{ title: string; cards: CardView[] } | null>(null);
  const [confirmSurrender, setConfirmSurrender] = useState(false);
  const send = useMutation({
    mutationFn: (intent: Intent) => api(`/duels/${duelId}/intents`, { method: 'POST', body: JSON.stringify(intent) }),
    onSettled: () => {
      setChoosing(null);
      setSelected(null);
    },
  });

  if (!view) return <p>{connected ? 'Loading the duel…' : 'Connecting…'}</p>;

  const me = view.you;
  const foe: Seat = me === 0 ? 1 : 0;
  const has = <T extends LegalAction['type']>(type: T) =>
    view.actions.find((a): a is Extract<LegalAction, { type: T }> => a.type === type);
  const actionsFor = (id: string) =>
    view.actions.filter((a) => ('card' in a && a.card === id) || (a.type === 'attack' && a.attacker === id));

  function start(action: LegalAction) {
    switch (action.type) {
      case 'normalSummon':
      case 'setMonster':
        if (action.tributes > 0) return setChoosing({ kind: 'tributes', action, chosen: [] });
        return send.mutate({ type: action.type, card: action.card, tributes: [] });
      case 'attack':
        if (action.direct) return send.mutate({ type: 'attack', attacker: action.attacker, target: 'direct' });
        return setChoosing({ kind: 'target', action });
      case 'endTurn':
        if (action.discard > 0) return setChoosing({ kind: 'discard', count: action.discard, chosen: [] });
        return send.mutate({ type: 'endTurn', discard: [] });
      case 'setSpellTrap':
      case 'flipSummon':
      case 'changePosition':
        return send.mutate({ type: action.type, card: action.card });
      case 'enterBattle':
      case 'enterMain2':
      case 'surrender':
        return send.mutate({ type: action.type });
    }
  }

  /** Clicking one of your own cards: pick it for the current choice, or select it to see what it can do. */
  function clickOwn(id: string) {
    if (choosing?.kind === 'tributes' && choosing.action.tributeFrom.includes(id)) {
      const chosen = toggle(choosing.chosen, id);
      if (chosen.length === choosing.action.tributes) {
        return send.mutate({ type: choosing.action.type, card: choosing.action.card, tributes: chosen });
      }
      return setChoosing({ ...choosing, chosen });
    }
    if (choosing?.kind === 'discard' && view!.players[me].hand.some((c) => idOf(c) === id)) {
      const chosen = toggle(choosing.chosen, id);
      if (chosen.length === choosing.count) return send.mutate({ type: 'endTurn', discard: chosen });
      return setChoosing({ ...choosing, chosen });
    }
    setChoosing(null);
    setSelected(selected === id ? null : id);
  }

  function clickFoeMonster(zone: number) {
    if (choosing?.kind === 'target' && choosing.action.targets.includes(zone)) {
      send.mutate({ type: 'attack', attacker: choosing.action.attacker, target: zone });
    }
  }

  const picked = (id: string | null) =>
    id !== null && (choosing?.kind === 'tributes' || choosing?.kind === 'discard') && choosing.chosen.includes(id);
  const pickable = (id: string | null) =>
    id !== null &&
    ((choosing?.kind === 'tributes' && choosing.action.tributeFrom.includes(id)) ||
      (choosing?.kind === 'discard' && view.players[me].hand.some((c) => idOf(c) === id)));

  const yourTurn = view.turnPlayer === me && !view.result;
  const selectedActions = selected ? actionsFor(selected) : [];

  return (
    <div className="duel">
      <div className="table">
        <Side
          side={view.players[foe]}
          foe
          onInspect={setInspected}
          onPile={setPile}
          onZone={clickFoeMonster}
          targetable={choosing?.kind === 'target' ? choosing.action.targets : []}
        />
        <div className="phase-bar">
          <span>
            Turn {view.turn} · <strong>{yourTurn ? 'Your turn' : `${view.players[view.turnPlayer].name}'s turn`}</strong> ·{' '}
            {phaseNames[view.phase]}
          </span>
          <span className="row">
            {has('enterBattle') && <button onClick={() => start(has('enterBattle')!)}>Battle Phase</button>}
            {has('enterMain2') && <button onClick={() => start(has('enterMain2')!)}>Main Phase 2</button>}
            {has('endTurn') && <button onClick={() => start(has('endTurn')!)}>End turn</button>}
          </span>
        </div>
        <Side
          side={view.players[me]}
          onInspect={setInspected}
          onPile={setPile}
          onCard={clickOwn}
          selected={selected}
          picked={picked}
          pickable={pickable}
        />
      </div>

      <aside className="panel">
        {view.result && (
          <div className="banner">
            {view.result.winner === null ? 'Draw.' : view.result.winner === me ? 'You won!' : 'You lost.'}
          </div>
        )}
        {!connected && <p className="error">Reconnecting…</p>}
        {send.isError && <p className="error">{errorText(send.error)}</p>}

        {choosing && (
          <div className="prompt">
            <p>
              {choosing.kind === 'tributes' &&
                `Choose ${choosing.action.tributes - choosing.chosen.length} more monster${choosing.action.tributes - choosing.chosen.length === 1 ? '' : 's'} to Tribute.`}
              {choosing.kind === 'target' && "Choose one of your opponent's monsters to attack."}
              {choosing.kind === 'discard' && `Your hand is over 6 cards. Choose ${choosing.count - choosing.chosen.length} to discard.`}
            </p>
            <button onClick={() => setChoosing(null)}>Cancel</button>
          </div>
        )}

        {!choosing && selectedActions.length > 0 && (
          <div className="row">
            {selectedActions.map((a, i) => (
              <button key={i} onClick={() => start(a)} disabled={send.isPending}>
                {actionLabel(a, view)}
              </button>
            ))}
          </div>
        )}

        {inspected && <CardDetail card={inspected} />}

        {pile && (
          <div>
            <h3>
              {pile.title} ({pile.cards.length}) <button onClick={() => setPile(null)}>Close</button>
            </h3>
            <div className="card-grid small">
              {pile.cards.map((c, i) => (
                <button key={i} className="plain" onMouseEnter={() => dataOf(c) && setInspected(dataOf(c))}>
                  <CardFace card={dataOf(c)} />
                </button>
              ))}
            </div>
          </div>
        )}

        <ol className="log">
          {view.log.map((line, i) => (
            <li key={i}>{line}</li>
          ))}
        </ol>

        {has('surrender') &&
          (confirmSurrender ? (
            <p className="row">
              Surrender this duel?
              <button onClick={() => start({ type: 'surrender' })}>Yes, surrender</button>
              <button onClick={() => setConfirmSurrender(false)}>No</button>
            </p>
          ) : (
            <button className="quiet" onClick={() => setConfirmSurrender(true)}>
              Surrender
            </button>
          ))}
      </aside>
    </div>
  );
}

function actionLabel(a: LegalAction, view: PlayerView): string {
  const tributes = (n: number) => (n > 0 ? ` (Tribute ${n})` : '');
  switch (a.type) {
    case 'normalSummon':
      return `Normal Summon${tributes(a.tributes)}`;
    case 'setMonster':
      return `Set${tributes(a.tributes)}`;
    case 'setSpellTrap':
      return 'Set';
    case 'flipSummon':
      return 'Flip Summon';
    case 'changePosition': {
      const m = view.players[view.you].monsters.find((z) => z && idOf(z.card) === a.card);
      return m?.position === 'attack' ? 'Change to Defense' : 'Change to Attack';
    }
    case 'attack':
      return a.direct ? 'Attack directly' : 'Attack';
    default:
      return a.type;
  }
}

const toggle = (list: string[], id: string) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);

interface SideProps {
  side: PlayerSideView;
  foe?: boolean;
  onInspect: (card: CardData) => void;
  onPile: (pile: { title: string; cards: CardView[] }) => void;
  onCard?: (id: string) => void;
  onZone?: (zone: number) => void;
  selected?: string | null;
  picked?: (id: string | null) => boolean;
  pickable?: (id: string | null) => boolean;
  targetable?: number[];
}

/** One player's half of the table. The opponent's half is mirrored: hand on top, monsters nearest the middle. */
function Side(props: SideProps) {
  const { side, foe = false, onPile } = props;
  const piles = (
    <div className="piles">
      <div className="pile">
        <span className="muted">Deck</span>
        <CardFace card={null} />
        <span>{side.deckCount}</span>
      </div>
      <button className="pile plain" onClick={() => onPile({ title: `${side.name}'s Graveyard`, cards: side.graveyard })}>
        <span className="muted">GY</span>
        {side.graveyard.length > 0 ? <CardFace card={dataOf(side.graveyard.at(-1)!)} /> : <div className="card empty" />}
        <span>{side.graveyard.length}</span>
      </button>
      <button className="pile plain" onClick={() => onPile({ title: `${side.name}'s Extra Deck`, cards: side.extra })}>
        <span className="muted">Extra</span>
        <CardFace card={null} />
        <span>{side.extra.length}</span>
      </button>
    </div>
  );
  const info = (
    <div className="player-info">
      <strong>{side.name}</strong>
      <span className="lp">LP {side.lp}</span>
    </div>
  );
  const hand = (
    <div className="hand">
      {side.hand.map((c, i) => (
        <CardSlot key={idOf(c) ?? `h${i}`} view={c} {...props} />
      ))}
    </div>
  );
  const monsters = <Zones zones={side.monsters} kind="monster" {...props} />;
  const spellTraps = <Zones zones={side.spellTraps} kind="spellTrap" {...props} />;

  return (
    <div className={`side${foe ? ' foe' : ''}`}>
      {foe ? (
        <>
          {info}
          {hand}
          <div className="field">
            <div className="rows">
              {spellTraps}
              {monsters}
            </div>
            {piles}
          </div>
        </>
      ) : (
        <>
          <div className="field">
            <div className="rows">
              {monsters}
              {spellTraps}
            </div>
            {piles}
          </div>
          {hand}
          {info}
        </>
      )}
    </div>
  );
}

function Zones({ zones, kind, ...props }: { zones: (FieldCardView | null)[]; kind: 'monster' | 'spellTrap' } & SideProps) {
  return (
    <div className="zones">
      {zones.map((z, i) => {
        const target = kind === 'monster' && props.targetable?.includes(i);
        return (
          <div
            key={i}
            className={`zone${target ? ' target' : ''}`}
            onClick={target ? () => props.onZone?.(i) : undefined}
          >
            {z && <CardSlot view={z.card} position={z.position} faceDown={!z.faceUp} {...props} />}
          </div>
        );
      })}
    </div>
  );
}

function CardSlot({
  view,
  position = 'attack',
  faceDown = false,
  onCard,
  onInspect,
  selected,
  picked,
  pickable,
}: { view: CardView; position?: 'attack' | 'defense'; faceDown?: boolean } & SideProps) {
  const id = idOf(view);
  const data = dataOf(view);
  const classes = ['slot', id && id === selected && 'selected', picked?.(id) && 'picked', pickable?.(id) && 'pickable']
    .filter(Boolean)
    .join(' ');
  return (
    <motion.div
      layout
      layoutId={id ?? undefined}
      className={classes}
      animate={{ rotate: position === 'defense' ? 90 : 0 }}
      onMouseEnter={() => data && onInspect(data)}
      onClick={(e) => {
        if (id && onCard) {
          e.stopPropagation();
          onCard(id);
        }
      }}
    >
      <CardFace card={data} faceDown={faceDown} />
    </motion.div>
  );
}
