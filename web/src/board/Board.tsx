import './board.css';
import { useMutation } from '@tanstack/react-query';
import type { CardView, Intent, LegalAction, PlayerView, Seat } from '@yugioh/engine';
import { AnimatePresence, motion, MotionConfig } from 'motion/react';
import { useCallback, useEffect, useLayoutEffect, useReducer, useState } from 'react';
import { Link } from 'react-router';
import { api, errorText } from '../api.ts';
import { ActionMenu } from './ActionMenu.tsx';
import { idOf, imageUrl, preloadImages } from './Card.tsx';
import { CardTooltipProvider } from './CardTooltip.tsx';
import { cueMs, playCue } from './cues.ts';
import { DuelLog } from './DuelLog.tsx';
import { Field } from './Field.tsx';
import { FoeHand, OwnHand } from './Hand.tsx';
import { BoardLookProvider, useBoardSize, type CardMarks } from './look.ts';
import { LpPlate } from './LpPlate.tsx';
import { PhaseStrip } from './PhaseStrip.tsx';
import { PileViewer } from './PileViewer.tsx';
import { systemReducesMotion, useDuelSettings } from './settings.ts';
import { useDuel } from './useDuel.ts';

/** What the player is in the middle of doing on the board. */
type Mode =
  | { kind: 'idle' }
  | { kind: 'menu'; id: string; anchor: HTMLElement }
  | { kind: 'tributes'; action: Extract<LegalAction, { type: 'normalSummon' | 'setMonster' }>; chosen: string[] }
  | { kind: 'target'; action: Extract<LegalAction, { type: 'attack' }> }
  | { kind: 'discard'; count: number; chosen: string[] };

const idle: Mode = { kind: 'idle' };

/** How long to wait for card images before showing the board anyway. */
const PRELOAD_TIMEOUT_MS = 4000;

export function Board({ duelId }: { duelId: string }) {
  const [settings, updateSettings] = useDuelSettings();
  const reduceMotion = settings.reduceMotion || systemReducesMotion();
  const pace = useCallback((event: Parameters<typeof cueMs>[0], waiting: number) => cueMs(event, waiting, settings, reduceMotion), [settings, reduceMotion]);
  const { shown, connected } = useDuel(duelId, pace);
  const [mode, setMode] = useReducer((_: Mode, next: Mode) => next, idle);
  const [pile, setPile] = useState<{ title: string; cards: CardView[] } | null>(null);
  const [highlight, setHighlight] = useState<string[]>([]);
  const [dragging, setDragging] = useState(false);
  const [confirmSurrender, setConfirmSurrender] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [table, setTable] = useState<HTMLDivElement | null>(null);
  const look = useBoardSize(table);
  const ready = usePreload(shown?.view ?? null, look.imageSize);

  const send = useMutation({
    mutationFn: (intent: Intent) => api(`/duels/${duelId}/intents`, { method: 'POST', body: JSON.stringify(intent) }),
    onSettled: () => setMode(idle),
  });

  // Extra animations for the step being shown, run before the browser paints it.
  const cue = shown?.cue ?? null;
  useLayoutEffect(() => {
    if (!cue || !shown || !table || reduceMotion) return;
    playCue(table, cue, shown.prev, shown.view, cueMs(cue.event, 0, settings, reduceMotion));
    // Only a new step should play anything.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cue?.seq]);

  // A choice in progress makes no sense on a board that changed under it.
  useEffect(() => {
    setMode(idle);
  }, [shown?.view.turn, shown?.view.phase]);

  if (!shown) return <div className="duel-loading">{connected ? 'Loading the duel…' : 'Connecting…'}</div>;

  const { view, log } = shown;
  const me = view.you;
  const foe: Seat = me === 0 ? 1 : 0;
  const busy = cue !== null || send.isPending;
  const actions = busy ? [] : view.actions;
  const has = <T extends LegalAction['type']>(type: T) => actions.find((a): a is Extract<LegalAction, { type: T }> => a.type === type);
  const actionsFor = (id: string) => actions.filter((a) => ('card' in a && a.card === id) || (a.type === 'attack' && a.attacker === id));
  const playable = new Set(actions.flatMap((a) => ('card' in a ? [a.card] : a.type === 'attack' ? [a.attacker] : [])));
  const myHand = view.players[me].hand.map((c) => idOf(c)!);

  function start(action: LegalAction) {
    switch (action.type) {
      case 'normalSummon':
      case 'setMonster':
        if (action.tributes > 0) return setMode({ kind: 'tributes', action, chosen: [] });
        return send.mutate({ type: action.type, card: action.card, tributes: [] });
      case 'attack':
        if (action.direct) return send.mutate({ type: 'attack', attacker: action.attacker, target: 'direct' });
        return setMode({ kind: 'target', action });
      case 'endTurn':
        if (action.discard > 0) return setMode({ kind: 'discard', count: action.discard, chosen: [] });
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

  /** Clicking one of your own cards: pick it for the current choice, or open its action menu. */
  function clickOwn(id: string, anchor: HTMLElement) {
    if (busy) return;
    if (mode.kind === 'tributes' && mode.action.tributeFrom.includes(id)) {
      const chosen = toggle(mode.chosen, id);
      if (chosen.length === mode.action.tributes) return send.mutate({ type: mode.action.type, card: mode.action.card, tributes: chosen });
      return setMode({ ...mode, chosen });
    }
    if (mode.kind === 'discard' && myHand.includes(id)) {
      const chosen = toggle(mode.chosen, id);
      if (chosen.length === mode.count) return send.mutate({ type: 'endTurn', discard: chosen });
      return setMode({ ...mode, chosen });
    }
    if (mode.kind === 'menu' && mode.id === id) return setMode(idle);
    setMode(actionsFor(id).length > 0 ? { kind: 'menu', id, anchor } : idle);
  }

  function clickTarget(zone: number) {
    if (mode.kind === 'target' && mode.action.targets.includes(zone)) {
      send.mutate({ type: 'attack', attacker: mode.action.attacker, target: zone });
    }
  }

  const choosing = mode.kind === 'tributes' || mode.kind === 'target' || mode.kind === 'discard';
  const pickable = (id: string) =>
    (mode.kind === 'tributes' && mode.action.tributeFrom.includes(id)) || (mode.kind === 'discard' && myHand.includes(id));
  const marks: CardMarks = {
    classes: (id) =>
      id === null
        ? ''
        : [
            mode.kind === 'menu' && mode.id === id && 'selected',
            (mode.kind === 'tributes' || mode.kind === 'discard') && mode.chosen.includes(id) && 'picked',
            pickable(id) && 'pickable',
            mode.kind === 'target' && mode.action.attacker === id && 'selected',
            !choosing && playable.has(id) && 'playable',
            highlight.includes(id) && 'highlight',
          ]
            .filter(Boolean)
            .join(' '),
  };

  const prompt = choosing && (
    <span className="choice-prompt">
      {mode.kind === 'tributes' && `Choose ${plural(mode.action.tributes - mode.chosen.length, 'monster')} to Tribute.`}
      {mode.kind === 'target' && "Choose one of your opponent's monsters to attack."}
      {mode.kind === 'discard' && `Your hand is over 6 cards. Choose ${plural(mode.count - mode.chosen.length, 'card')} to discard.`}
      <button onClick={() => setMode(idle)}>Cancel</button>
    </span>
  );

  const yourTurn = view.turnPlayer === me && !view.result;
  const enterBattle = has('enterBattle');
  const enterMain2 = has('enterMain2');
  const endTurn = has('endTurn');
  const canSurrender = !view.result;
  const result = view.result;
  const resultText = log.findLast((e) => e.event.type === 'duelEnded')?.text;

  return (
    <MotionConfig reducedMotion={reduceMotion ? 'always' : 'never'}>
      <BoardLookProvider value={look}>
        <CardTooltipProvider suppressed={choosing || dragging || mode.kind === 'menu'}>
          <div className={`duel${choosing ? ' choosing' : ''}`} style={{ '--zone': `${look.zone}px` } as React.CSSProperties}>
            <div className="table" ref={setTable}>
              {!ready ? (
                <div className="duel-loading">Loading cards…</div>
              ) : (
                <>
                  <div className="hand-row foe-row">
                    <LpPlate seat={foe} name={view.players[foe].name} lp={view.players[foe].lp} cue={cue} active={view.turnPlayer === foe} />
                    <FoeHand seat={foe} count={view.players[foe].hand.length} />
                  </div>
                  <Field
                    seat={foe}
                    side={view.players[foe]}
                    mine={false}
                    marks={marks}
                    targetable={mode.kind === 'target' ? mode.action.targets : []}
                    onCard={() => undefined}
                    onTarget={clickTarget}
                    onPile={(title, cards) => setPile({ title, cards })}
                  />
                  <PhaseStrip
                    turn={view.turn}
                    turnLabel={yourTurn ? 'Your turn' : `${view.players[view.turnPlayer].name}'s turn`}
                    yours={yourTurn}
                    phase={view.phase}
                    goTo={{
                      ...(enterBattle && { battle: () => start(enterBattle) }),
                      ...(enterMain2 && { main2: () => start(enterMain2) }),
                      ...(endTurn && { end: () => start(endTurn) }),
                    }}
                    prompt={prompt || null}
                    endTurn={endTurn && !choosing ? () => start(endTurn) : null}
                  />
                  <Field
                    seat={me}
                    side={view.players[me]}
                    mine
                    marks={marks}
                    targetable={[]}
                    onCard={clickOwn}
                    onTarget={() => undefined}
                    onPile={(title, cards) => setPile({ title, cards })}
                  />
                  <div className="hand-row own-row">
                    <LpPlate seat={me} name={view.players[me].name} lp={view.players[me].lp} cue={cue} active={view.turnPlayer === me} />
                    <OwnHand duelId={duelId} seat={me} cards={view.players[me].hand} marks={marks} onCard={clickOwn} onDragging={setDragging} />
                  </div>
                </>
              )}

              <AnimatePresence>
                {cue?.event.type === 'turnStarted' && (
                  <motion.div
                    key={cue.seq}
                    className={`turn-banner${cue.event.player === me ? ' yours' : ''}`}
                    initial={{ opacity: 0, x: '-30%' }}
                    animate={{ opacity: 1, x: '0%' }}
                    exit={{ opacity: 0, x: '30%' }}
                    transition={{ duration: 0.3, ease: 'easeOut' }}
                  >
                    {cue.event.player === me ? 'Your turn' : `${view.players[cue.event.player].name}'s turn`}
                  </motion.div>
                )}
              </AnimatePresence>

              {result && cue === null && (
                <motion.div className="result-overlay" initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }}>
                  <strong>{result.winner === null ? 'Draw' : result.winner === me ? 'Victory' : 'Defeat'}</strong>
                  {resultText && <span>{resultText}</span>}
                  <Link className="button" to="/">
                    Back to duels
                  </Link>
                </motion.div>
              )}
            </div>

            <aside className="panel">
              <div className="row panel-top">
                <Link to="/">← Duels</Link>
                <span className="spacer" />
                <button className="quiet" onClick={() => setShowSettings((s) => !s)} aria-expanded={showSettings}>
                  Settings
                </button>
                {canSurrender && !confirmSurrender && (
                  <button className="quiet" onClick={() => setConfirmSurrender(true)}>
                    Surrender
                  </button>
                )}
              </div>
              {canSurrender && confirmSurrender && (
                <p className="row">
                  Surrender this duel?
                  <button onClick={() => send.mutate({ type: 'surrender' })}>Yes, surrender</button>
                  <button onClick={() => setConfirmSurrender(false)}>No</button>
                </p>
              )}
              {showSettings && (
                <div className="settings">
                  <label>
                    Animation speed{' '}
                    <select value={settings.speed} onChange={(e) => updateSettings({ speed: e.target.value as 'normal' | 'fast' })}>
                      <option value="normal">Normal</option>
                      <option value="fast">Fast</option>
                    </select>
                  </label>
                  <label>
                    <input type="checkbox" checked={settings.reduceMotion} onChange={(e) => updateSettings({ reduceMotion: e.target.checked })} /> Reduce motion
                  </label>
                  <p className="muted small">Right-click a card or hold Shift to pin its details. Drag cards in your hand to reorder them.</p>
                </div>
              )}
              {!connected && <p className="error">Reconnecting…</p>}
              {send.isError && <p className="error">{errorText(send.error)}</p>}
              <DuelLog log={log} onHighlight={setHighlight} />
            </aside>

            {mode.kind === 'menu' && (
              <ActionMenu
                anchor={mode.anchor}
                items={actionsFor(mode.id).map((a) => ({ label: actionLabel(a, view), run: () => start(a) }))}
                onClose={() => setMode(idle)}
              />
            )}
            {pile && <PileViewer title={pile.title} cards={pile.cards} onClose={() => setPile(null)} />}
          </div>
        </CardTooltipProvider>
      </BoardLookProvider>
    </MotionConfig>
  );
}

/** Loads the images of your own deck before the board appears, so cards don't pop in mid-duel. The opponent's cards load as they're revealed, since their decklist isn't yours to know. */
function usePreload(view: PlayerView | null, size: 'small' | 'full') {
  const [ready, setReady] = useState(false);
  const deckList = view?.deckList.join();
  useEffect(() => {
    if (!deckList) return;
    const codes = deckList.split(',').map(Number);
    const urls = codes.flatMap((c) => (size === 'full' ? [imageUrl(c, 'full')] : [imageUrl(c, 'small'), imageUrl(c, 'full')]));
    let done = false;
    const finish = () => !done && ((done = true), setReady(true));
    void preloadImages(urls).then(finish);
    const timer = setTimeout(finish, PRELOAD_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [deckList, size]);
  return ready;
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
const plural = (n: number, word: string) => `${n} more ${word}${n === 1 ? '' : 's'}`;
