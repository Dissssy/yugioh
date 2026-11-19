import './board.css';
import { useMutation } from '@tanstack/react-query';
import type { Intent, LegalAction, PlayerView, Seat } from '@yugioh/engine';
import { AnimatePresence, motion, MotionConfig } from 'motion/react';
import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react';
import { Link } from 'react-router';
import { api, errorText } from '../api.ts';
import { ActionMenu } from './ActionMenu.tsx';
import { Arrows, cardCentre, dropAt, dropCentre, type Point } from './aim.tsx';
import { dataOf, idOf, imageUrl, preloadImages } from './Card.tsx';
import { CardTooltipProvider } from './CardTooltip.tsx';
import { ChoiceBar, ChoiceProvider, pileKey, useBoardChoice, type PileKind } from './choice.tsx';
import { cueMs, playCue } from './cues.ts';
import { ChatInput, DuelLog, type Contest } from './DuelLog.tsx';
import { dropKey, Field, type Row } from './Field.tsx';
import { FoeHand, OwnHand, type HandDrag } from './Hand.tsx';
import { BoardLookProvider, useBoardSize, type CardMarks } from './look.ts';
import { LpPlate } from './LpPlate.tsx';
import { PhaseStrip } from './PhaseStrip.tsx';
import { PileViewer } from './PileViewer.tsx';
import { ReportRuling } from './ReportRuling.tsx';
import { systemReducesMotion, useDuelSettings } from './settings.ts';
import { useDuel } from './useDuel.ts';

type Summon = Extract<LegalAction, { type: 'normalSummon' | 'setMonster' }>;
type Activate = Extract<LegalAction, { type: 'activate' }>;
/** Activating a Spell or Trap from the hand, which puts it in a zone the player picks. */
type ActivateFromHand = Activate & { zones: number[] };
/** An action that puts a card from the hand into a zone the player picks. */
type Placeable = Summon | Extract<LegalAction, { type: 'setSpellTrap' }> | ActivateFromHand;
type Attack = Extract<LegalAction, { type: 'attack' }>;
type PlaceIntent = Extract<Intent, { type: Placeable['type'] }>;

const isPlaceable = (a: LegalAction): a is Placeable =>
  a.type === 'normalSummon' || a.type === 'setMonster' || a.type === 'setSpellTrap' || (a.type === 'activate' && a.zones !== null);
const rowOf = (a: Placeable | PlaceIntent): Row => (a.type === 'setSpellTrap' || a.type === 'activate' ? 's' : 'm');

/** What the player is in the middle of doing on the board. */
type Mode =
  | { kind: 'idle' }
  | { kind: 'menu'; id: string; anchor: HTMLElement }
  /** Picking a zone by clicking, after choosing the action from the card's menu. */
  | { kind: 'zone'; action: Placeable }
  /** A card was dropped on a zone where it can be Summoned or Set: which one? */
  | { kind: 'place'; options: Placeable[]; zone: number; anchor: HTMLElement }
  /** `keep` is the monster in the chosen zone, which must be one of the tributes. */
  | { kind: 'tributes'; action: Summon; zone: number; chosen: string[]; keep: string | null }
  | { kind: 'target'; action: Attack }
  | { kind: 'discard'; count: number; chosen: string[] };

/** A drag in progress: a hand card toward a zone, or an attacker's arrow toward a target. */
type Drag = { kind: 'card'; id: string } | { kind: 'aim'; action: Attack; from: Point; to: Point };

/** How far the pointer moves on a monster before a press becomes an aimed attack rather than a click. */
const AIM_THRESHOLD_PX = 8;

const idle: Mode = { kind: 'idle' };

/** How long to wait for card images before showing the board anyway. */
const PRELOAD_TIMEOUT_MS = 4000;

export function Board({ duelId }: { duelId: string }) {
  const [settings, updateSettings] = useDuelSettings();
  const reduceMotion = settings.reduceMotion || systemReducesMotion();
  const pace = useCallback((event: Parameters<typeof cueMs>[0], waiting: number) => cueMs(event, waiting, settings, reduceMotion), [settings, reduceMotion]);
  const { shown, connected, judging } = useDuel(duelId, pace);
  const [mode, setMode] = useReducer((_: Mode, next: Mode) => next, idle);
  /** The open pile viewer, by `pileKey`. */
  const [pile, setPile] = useState<string | null>(null);
  /** The judge's question to this player (only the player asked gets it), answered on the board. */
  const choice = useBoardChoice(judging?.prompt ?? null);
  const [highlight, setHighlight] = useState<string[]>([]);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [over, setOver] = useState<string | null>(null);
  /** Lines from each effect waiting to resolve to its targets. */
  const [targetArrows, setTargetArrows] = useState<{ from: Point; to: Point }[]>([]);
  /** Rulings this player has contested here, until the server's appeal entry arrives. */
  const [contested, setContested] = useState<number[]>([]);
  /** Set when an aimed attack ends on the attacker, so the click that follows doesn't open its menu. */
  const swallowClick = useRef(false);
  /** A card sent to a zone, kept over it until the step that moves it arrives. */
  const [sent, setSent] = useState<{ id: string; key: string } | null>(null);
  const [confirmSurrender, setConfirmSurrender] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [table, setTable] = useState<HTMLDivElement | null>(null);
  const look = useBoardSize(table);
  const ready = usePreload(shown?.view ?? null, look.imageSize);

  const send = useMutation({
    mutationFn: (intent: Intent) => api(`/duels/${duelId}/intents`, { method: 'POST', body: JSON.stringify(intent) }),
    onSettled: () => setMode(idle),
  });
  const answer = useMutation({
    mutationFn: (body: { prompt: string; picks: string[] }) => api(`/duels/${duelId}/answer`, { method: 'POST', body: JSON.stringify(body) }),
  });
  const chat = useMutation({
    mutationFn: (text: string) => api(`/duels/${duelId}/chat`, { method: 'POST', body: JSON.stringify({ text }) }),
  });
  const contestRuling = useMutation({
    mutationFn: (body: { seq: number; note: string }) => api(`/duels/${duelId}/contest`, { method: 'POST', body: JSON.stringify(body) }),
    onMutate: ({ seq }) => setContested((c) => [...c, seq]),
    onError: (_, { seq }) => setContested((c) => c.filter((x) => x !== seq)),
  });

  // Extra animations for the step being shown, run before the browser paints it.
  const cue = shown?.cue ?? null;
  useLayoutEffect(() => {
    if (!cue || !shown || !table || reduceMotion) return;
    playCue(table, cue, shown.prev, shown.view, cueMs(cue.event, 0, settings, reduceMotion));
    // Only a new step should play anything.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cue?.seq]);

  // Once the sent card has left the hand there is nothing left to hold; nor if the judge refused to let it go.
  useEffect(() => {
    if (!sent || !shown) return;
    const refused = shown.cue?.event.type === 'judged' && !shown.cue.event.legal && shown.cue.event.card === sent.id;
    if (refused || !shown.view.players[shown.view.you].hand.some((c) => idOf(c) === sent.id)) setSent(null);
  }, [shown, sent]);

  // Each effect waiting to resolve points at its targets, measured once the board has laid out.
  const chain = shown?.view.chain;
  useLayoutEffect(() => {
    const arrows = (chain ?? []).flatMap((link) => {
      const from = idOf(link.card) && cardCentre(idOf(link.card)!);
      return from ? link.targets.flatMap((t) => (cardCentre(t) ? [{ from, to: cardCentre(t)! }] : [])) : [];
    });
    setTargetArrows(arrows);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(chain), look.zone, ready, shown?.cue?.seq]);

  // A choice in progress makes no sense on a board that changed under it.
  useEffect(() => {
    setMode(idle);
  }, [shown?.view.turn, shown?.view.phase]);

  // A new question opens the pile its cards are in when they're all in one; an answered one closes the viewer.
  const promptId = choice?.prompt.id;
  useEffect(() => {
    setPile(choice?.onlyPile ?? null);
    answer.reset();
    // Only a new question should change the viewer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [promptId]);

  if (!shown) return <div className="duel-loading">{connected ? 'Loading the duel…' : 'Connecting…'}</div>;

  const { view, log } = shown;
  const me = view.you;
  const foe: Seat = me === 0 ? 1 : 0;
  // Nothing can be done while a step plays, a request is on its way, or the judge is at work.
  const busy = cue !== null || send.isPending || judging !== null;
  const actions: LegalAction[] = busy ? [] : view.actions;
  const has = <T extends LegalAction['type']>(type: T) => actions.find((a): a is Extract<LegalAction, { type: T }> => a.type === type);
  const actionsFor = (id: string) => actions.filter((a) => ('card' in a && a.card === id) || (a.type === 'attack' && a.attacker === id));
  const playable = new Set(actions.flatMap((a) => ('card' in a ? [a.card] : a.type === 'attack' ? [a.attacker] : [])));
  const myHand = view.players[me].hand.map((c) => idOf(c)!);

  const myMonsters = view.players[me].monsters;
  const cardName = (id: string) => {
    const c = view.players[me].hand.find((h) => idOf(h) === id);
    return (c && dataOf(c)?.name) ?? 'the card';
  };
  const placeables = (id: string) => actionsFor(id).filter(isPlaceable);
  const attackOf = (id: string) => actionsFor(id).find((a): a is Attack => a.type === 'attack');
  /** Placeable actions that may put card `id` in this zone. */
  const fitsZone = (options: Placeable[], row: Row, zone: number) => options.filter((a) => rowOf(a) === row && a.zones.includes(zone));

  function start(action: LegalAction) {
    switch (action.type) {
      case 'normalSummon':
      case 'setMonster':
      case 'setSpellTrap':
        return setMode({ kind: 'zone', action });
      case 'attack':
        if (action.direct) return send.mutate({ type: 'attack', attacker: action.attacker, target: 'direct' });
        return setMode({ kind: 'target', action });
      case 'endTurn':
        if (action.discard > 0) return setMode({ kind: 'discard', count: action.discard, chosen: [] });
        return send.mutate({ type: 'endTurn', discard: [] });
      case 'activate':
        if (action.zones !== null) return setMode({ kind: 'zone', action: { ...action, zones: action.zones } });
        return send.mutate({ type: 'activate', card: action.card, effect: action.effect, zone: null });
      case 'flipSummon':
      case 'changePosition':
        return send.mutate({ type: action.type, card: action.card });
      case 'enterBattle':
      case 'enterMain2':
      case 'surrender':
        return send.mutate({ type: action.type });
    }
  }

  /** Sends a card to its zone, holding it over the zone until the step that moves it arrives. */
  function play(intent: PlaceIntent) {
    setSent({ id: intent.card, key: dropKey(me, rowOf(intent), intent.zone!) });
    send.mutate(intent, { onError: () => setSent(null) });
  }

  /** Puts a card in the chosen zone, first asking for tributes if it needs them. */
  function place(action: Placeable, zone: number) {
    if (action.type === 'setSpellTrap') return play({ type: 'setSpellTrap', card: action.card, zone });
    if (action.type === 'activate') return play({ type: 'activate', card: action.card, effect: action.effect, zone });
    if (action.tributes === 0) return play({ type: action.type, card: action.card, tributes: [], zone });
    // Dropping onto one of your monsters tributes it, so its zone is free for the new one.
    const occupant = myMonsters[zone] ? idOf(myMonsters[zone].card) : null;
    const chosen = occupant ? [occupant] : [];
    if (chosen.length === action.tributes) return play({ type: action.type, card: action.card, tributes: chosen, zone });
    setMode({ kind: 'tributes', action, zone, chosen, keep: occupant });
  }

  /** Placing with several possible actions (Summon or Set) asks which, right where the card was dropped. */
  function placeAt(options: Placeable[], zone: number, anchor: HTMLElement): boolean {
    if (options.length === 1) place(options[0]!, zone);
    if (options.length > 1) setMode({ kind: 'place', options, zone, anchor });
    return options.length > 0;
  }

  /** Clicking one of your own cards: pick it for the current choice, or open its action menu. */
  function clickOwn(id: string, anchor: HTMLElement) {
    if (busy) return;
    if (swallowClick.current) {
      swallowClick.current = false;
      return;
    }
    if (mode.kind === 'tributes' && mode.action.tributeFrom.includes(id) && id !== mode.keep) {
      const chosen = toggle(mode.chosen, id);
      if (chosen.length === mode.action.tributes) {
        return play({ type: mode.action.type, card: mode.action.card, tributes: chosen, zone: mode.zone });
      }
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

  /** Whether a zone can be picked now, by click or drop. */
  function zoneState(seat: Seat, row: Row, zone: number): 'open' | 'over' | null {
    let open = false;
    // The zone a card was just dropped on stays lit while you pick Summon or Set.
    if (seat === me && mode.kind === 'place' && mode.zone === zone && fitsZone(mode.options, row, zone).length > 0) return 'over';
    if (seat === me) {
      const options = drag?.kind === 'card' ? placeables(drag.id) : mode.kind === 'zone' ? [mode.action] : [];
      open = fitsZone(options, row, zone).length > 0;
    } else if (row === 'm') {
      const attack = drag?.kind === 'aim' ? drag.action : mode.kind === 'target' ? mode.action : null;
      open = attack?.targets.includes(zone) ?? false;
    }
    return open ? (over === dropKey(seat, row, zone) ? 'over' : 'open') : null;
  }

  function clickZone(seat: Seat, row: Row, zone: number) {
    if (seat === me && mode.kind === 'zone' && fitsZone([mode.action], row, zone).length > 0) place(mode.action, zone);
    if (seat === foe && mode.kind === 'target' && mode.action.targets.includes(zone)) {
      send.mutate({ type: 'attack', attacker: mode.action.attacker, target: zone });
    }
  }

  const handDrag: HandDrag = {
    start: (id) => {
      setMode(idle);
      setDrag({ kind: 'card', id });
    },
    move: (_, point) => setOver(dropAt(point)),
    end: (id, point) => {
      const key = dropAt(point);
      setDrag(null);
      setOver(null);
      const [seat, row, zone] = key?.split(':') ?? [];
      if (busy || Number(seat) !== me || (row !== 'm' && row !== 's')) return false;
      const anchor = document.querySelector<HTMLElement>(`[data-drop="${key}"]`);
      return anchor !== null && placeAt(fitsZone(placeables(id), row, Number(zone)), Number(zone), anchor);
    },
  };

  /** Pressing one of your monsters that can attack, then dragging, aims an arrow at what to attack. */
  function pressOwn(id: string, e: React.PointerEvent<HTMLElement>) {
    const action = attackOf(id);
    if (busy || !action || e.button !== 0) return;
    const r = e.currentTarget.getBoundingClientRect();
    const from = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    const down = { x: e.clientX, y: e.clientY };
    let aiming = false;
    const directKey = `lp:${foe}`;
    const valid = (key: string | null) =>
      key !== null && (key === directKey ? action.direct : action.targets.some((z) => key === dropKey(foe, 'm', z)));
    const move = (ev: PointerEvent) => {
      const to = { x: ev.clientX, y: ev.clientY };
      if (!aiming && Math.hypot(to.x - down.x, to.y - down.y) < AIM_THRESHOLD_PX) return;
      aiming = true;
      const key = dropAt(to);
      setOver(key);
      setDrag({ kind: 'aim', action, from, to: (valid(key) && dropCentre(key!)) || to });
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (!aiming) return;
      swallowClick.current = true;
      setTimeout(() => (swallowClick.current = false), 0);
      setDrag(null);
      setOver(null);
      const key = dropAt({ x: ev.clientX, y: ev.clientY });
      if (!valid(key)) return;
      const target = key === directKey ? 'direct' : Number(key!.split(':')[2]);
      send.mutate({ type: 'attack', attacker: action.attacker, target });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  const choosing = mode.kind === 'tributes' || mode.kind === 'target' || mode.kind === 'discard' || mode.kind === 'zone';
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
            drag?.kind === 'aim' && drag.action.attacker === id && 'selected',
            mode.kind === 'zone' && mode.action.card === id && 'selected',
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
      {mode.kind === 'zone' && `Choose a zone for ${cardName(mode.action.card)}.`}
      {mode.kind === 'discard' && `Your hand is over 6 cards. Choose ${plural(mode.count - mode.chosen.length, 'card')} to discard.`}
      <button onClick={() => setMode(idle)}>Cancel</button>
    </span>
  );

  /** The card waiting over its zone: while you pick Summon or Set or its tributes, and until it moves there. */
  const held =
    mode.kind === 'place'
      ? { id: mode.options[0]!.card, key: dropKey(me, rowOf(mode.options[0]!), mode.zone) }
      : mode.kind === 'tributes'
        ? { id: mode.action.card, key: dropKey(me, 'm', mode.zone) }
        : sent && myHand.includes(sent.id) ? sent : null;

  const contest: Contest = {
    can: (seq) => !contested.includes(seq) && !log.some((e) => e.event.type === 'appealed' && e.event.judged === seq && e.event.by === me),
    send: (seq, note) => contestRuling.mutate({ seq, note }),
  };

  const choiceBar = choice && (
    <ChoiceBar
      choice={choice}
      pending={answer.isPending}
      error={answer.isError ? errorText(answer.error) : null}
      onConfirm={() => answer.mutate({ prompt: choice.prompt.id, picks: choice.picks })}
    />
  );

  /** A pile's viewer: its cards, or for your Deck only the ones you may pick. */
  const pileView = (key: string) => {
    const [seat, place] = key.split(':') as [string, PileKind];
    const side = view.players[Number(seat) as Seat];
    const whose = Number(seat) === me ? 'Your' : `${side.name}'s`;
    switch (place) {
      case 'graveyard':
        return { title: `${whose} Graveyard`, cards: side.graveyard };
      case 'banished':
        return { title: `${whose} banished cards`, cards: side.banished };
      case 'extra':
        return { title: `${whose} Extra Deck`, cards: side.extra };
      case 'deck':
        return { title: `${whose} Deck: the cards you may choose`, cards: choice?.inPile(key).map((o) => o.card) ?? [] };
    }
  };
  const openPile = pile && pileView(pile);

  /** What the judge is doing, in the phase strip. */
  const judgeNote = judging && (
    <span className="judging" role="status">
      <span className="dot" />
      {judging.waitingOn === me
        ? 'The judge is asking you something.'
        : judging.waitingOn !== null
          ? `Waiting for ${view.players[judging.waitingOn].name} to answer the judge…`
          : `The judge is ${judging.stage === 'activation' ? 'checking' : 'resolving'} ${dataOf(judging.card)?.name ?? 'a card'}…`}
    </span>
  );

  const lpTarget = (): 'open' | 'over' | null => {
    const attack = drag?.kind === 'aim' ? drag.action : null;
    return attack?.direct ? (over === `lp:${foe}` ? 'over' : 'open') : null;
  };

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
        <ChoiceProvider value={choice}>
          <CardTooltipProvider
            suppressed={choosing || drag !== null || mode.kind === 'menu' || mode.kind === 'place'}
            pinnedFooter={(card) => <ReportRuling key={card.code} duelId={duelId} card={card} />}
          >
            <div className={`duel${choosing || choice ? ' choosing' : ''}${drag ? ' dragging' : ''}`} style={{ '--zone': `${look.zone}px` } as React.CSSProperties}>
              <div className="table" ref={setTable}>
                {!ready ? (
                  <div className="duel-loading">Loading cards…</div>
                ) : (
                  <>
                    <div className="hand-row foe-row">
                      <LpPlate seat={foe} name={view.players[foe].name} lp={view.players[foe].lp} cue={cue} active={view.turnPlayer === foe} target={lpTarget()} />
                      <FoeHand seat={foe} count={view.players[foe].hand.length} />
                    </div>
                    <Field
                      seat={foe}
                      side={view.players[foe]}
                      mine={false}
                      marks={marks}
                      zoneState={(row, zone) => zoneState(foe, row, zone)}
                      onZone={(row, zone) => clickZone(foe, row, zone)}
                      onCard={() => undefined}
                      onPile={(place) => setPile(pileKey(foe, place))}
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
                      prompt={prompt || choiceBar || judgeNote || null}
                      endTurn={endTurn && !choosing ? () => start(endTurn) : null}
                    />
                    <Field
                      seat={me}
                      side={view.players[me]}
                      mine
                      marks={marks}
                      zoneState={(row, zone) => zoneState(me, row, zone)}
                      onZone={(row, zone) => clickZone(me, row, zone)}
                      onCard={clickOwn}
                      onCardPress={pressOwn}
                      onPile={(place) => setPile(pileKey(me, place))}
                    />
                    <div className="hand-row own-row">
                      <LpPlate seat={me} name={view.players[me].name} lp={view.players[me].lp} cue={cue} active={view.turnPlayer === me} />
                      <OwnHand duelId={duelId} seat={me} cards={view.players[me].hand} marks={marks} onCard={clickOwn} drag={handDrag} held={held} />
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
                {contestRuling.isError && <p className="error">{errorText(contestRuling.error)}</p>}
                {chat.isError && <p className="error">{errorText(chat.error)}</p>}
                <DuelLog log={log} onHighlight={setHighlight} contest={contest} />
                <ChatInput send={chat.mutateAsync} sending={chat.isPending} />
              </aside>

              {mode.kind === 'menu' && (
                <ActionMenu
                  anchor={mode.anchor}
                  items={actionsFor(mode.id).map((a) => ({ label: actionLabel(a, view), run: () => start(a) }))}
                  onClose={() => setMode(idle)}
                />
              )}
              {mode.kind === 'place' && (
                <ActionMenu
                  anchor={mode.anchor}
                  items={mode.options.map((a) => ({ label: actionLabel(a, view), run: () => place(a, mode.zone) }))}
                  onClose={() => setMode(idle)}
                />
              )}
              {drag?.kind === 'aim' && <Arrows kind="aim" arrows={[drag]} />}
              {targetArrows.length > 0 && <Arrows kind="target" arrows={targetArrows} />}
              {openPile && <PileViewer title={openPile.title} cards={openPile.cards} bar={choiceBar} onClose={() => setPile(null)} />}
            </div>
          </CardTooltipProvider>
        </ChoiceProvider>
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
    case 'activate': {
      // A card with one effect to activate just says so; with several, each names its own.
      const several = view.actions.filter((o) => o.type === 'activate' && o.card === a.card).length > 1;
      return several ? `Activate: ${a.text.length > 60 ? `${a.text.slice(0, 57)}…` : a.text}` : 'Activate';
    }
    default:
      return a.type;
  }
}

const toggle = (list: string[], id: string) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);
const plural = (n: number, word: string) => `${n} more ${word}${n === 1 ? '' : 's'}`;
