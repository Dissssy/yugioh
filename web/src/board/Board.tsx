import './board.css';
import { useMutation } from '@tanstack/react-query';
import { zonePick, type Intent, type LegalAction, type PlayerView, type Position, type Seat } from '@yugioh/engine';
import { AnimatePresence, motion, MotionConfig } from 'motion/react';
import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react';
import { Link } from 'react-router';
import { api, errorText, useCanPlay, useMe } from '../api.ts';
import { DuelSwitcher } from '../duelFeed.tsx';
import { OpponentCardsSetting } from '../pages/Account.tsx';
import { NotifySetting } from '../notify.tsx';
import { useSettings } from '../settings.ts';
import { ActionMenu } from './ActionMenu.tsx';
import { Arrows, cardCentre, dropAt, dropCentre, type Point } from './aim.tsx';
import { dataOf, idOf, imageUrl, preloadImages } from './Card.tsx';
import { CardTooltipProvider } from './CardTooltip.tsx';
import { ChoiceBar, ChoiceProvider, pileKey, useBoardChoice, type PileKind } from './choice.tsx';
import { awaitsAnswer, cueMs, playCue, soundOf } from './cues.ts';
import { play as playSound } from '../sound.ts';
import { ChatInput, DuelLog, type Asking, type Contest, type Escalate } from './DuelLog.tsx';
import { dropKey, ExtraMonsterZone, Field, type FieldProps, type Row } from './Field.tsx';
import { OwnHand, ReadOnlyHand, type HandDrag } from './Hand.tsx';
import { BoardLookProvider, useBoardSize, type CardMarks } from './look.ts';
import { LpPlate } from './LpPlate.tsx';
import { PhaseDial, PhaseStrip, phaseName, TurnLabel } from './PhaseStrip.tsx';
import { PileViewer } from './PileViewer.tsx';
import { ReportRuling } from './ReportRuling.tsx';
import { StartPanel } from './StartPanel.tsx';
import { systemReducesMotion, useDuelSettings } from './settings.ts';
import { KeyHelp, shortcutOf, type Shortcut } from './keys.tsx';
import { typing, useKeyboardNav } from './nav.ts';
import { ReplayBar } from './ReplayBar.tsx';
import { WatchBar } from './WatchBar.tsx';
import { CopyLink } from '../CopyLink.tsx';
import { DecisionPopup } from './DecisionPopup.tsx';
import { useSmallFrame } from '../discord.ts';
import { useDuel } from './useDuel.ts';
import { useReplay } from './useReplay.ts';

type Summon = Extract<LegalAction, { type: 'normalSummon' | 'setMonster' }>;
type Activate = Extract<LegalAction, { type: 'activate' }>;
/** Activating a Spell or Trap from the hand, which puts it in a zone the player picks. */
type ActivateFromHand = Activate & { zones: number[] };
/** An action that puts a card from the hand into a zone the player picks. */
type Placeable = Summon | Extract<LegalAction, { type: 'setSpellTrap' }> | ActivateFromHand;
type Attack = Extract<LegalAction, { type: 'attack' }>;
type ExtraSummon = Extract<LegalAction, { type: 'extraSummon' }>;
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
  /** Picking the materials for a Synchro or Xyz Summon on the board, then (if it may go to several) its zone. */
  | { kind: 'materials'; action: ExtraSummon; position: Position; chosen: string[] }
  | { kind: 'extraZone'; action: ExtraSummon; position: Position; materials: string[]; zones: number[] }
  | { kind: 'discard'; count: number; chosen: string[] };

/** A drag in progress: a hand card toward a zone, or an attacker's arrow toward a target. */
type Drag = { kind: 'card'; id: string } | { kind: 'aim'; action: Attack; from: Point; to: Point };

/** How far the pointer moves on a monster before a press becomes an aimed attack rather than a click. */
const AIM_THRESHOLD_PX = 8;

const idle: Mode = { kind: 'idle' };

/** Modes in which the player is choosing on the board, where a choice's Cancel and the keyboard's limits apply. */
const CHOOSING: Mode['kind'][] = ['tributes', 'target', 'discard', 'zone', 'materials', 'extraZone'];

/** How long to wait for card images before showing the board anyway. */
const PRELOAD_TIMEOUT_MS = 4000;

/**
 * A duel: the live one this player sits in, or one being watched, where nothing can be done: `live` as it happens,
 * by someone who isn't playing it, or a finished one played back (`replay`).
 */
export function Board({ duelId, watching }: { duelId: string; watching?: 'live' | 'replay' }) {
  const replay = watching === 'replay';
  const readOnly = watching !== undefined;
  /** The seat a spectator has at the bottom. */
  const [watchFrom, setWatchFrom] = useState<Seat>(0);
  const [settings, updateSettings] = useDuelSettings();
  const hasAccount = useMe().data?.kind === 'user';
  const canPlay = useCanPlay();
  const { opponentCards } = useSettings();
  const reduceMotion = settings.reduceMotion || systemReducesMotion();
  const pace = useCallback((event: Parameters<typeof cueMs>[0], waiting: number) => cueMs(event, waiting, settings, reduceMotion), [settings, reduceMotion]);
  const live = useDuel(replay ? null : duelId, pace, watching === 'live' ? watchFrom : null);
  const played = useReplay(replay ? duelId : null, pace);
  const { shown, connected, judging } = replay ? { shown: played.shown, connected: true, judging: null } : live;
  const controls = played.controls;
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
  /** Questions this player has escalated here, until the server's entry arrives. */
  const [escalated, setEscalated] = useState<number[]>([]);
  /** Whether the chat box sends to the judge, and about which card. */
  const [asking, setAsking] = useState<Asking | null>(null);
  /** Bumped to put focus in the chat box. */
  const [chatFocus, bumpChatFocus] = useReducer((n: number) => n + 1, 0);
  /** The hand card being moved by keyboard (Move in hand). */
  const [moving, setMoving] = useState<string | null>(null);
  const [showKeys, setShowKeys] = useState(false);
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const smallFrame = useSmallFrame();
  /** How many answers from the judge the log held when this player last asked, until the next one arrives. */
  const [awaiting, setAwaiting] = useState<number | null>(null);
  /** Set when an aimed attack ends on the attacker, so the click that follows doesn't open its menu. */
  const swallowClick = useRef(false);
  /** A card sent to a zone, kept over it until the step that moves it arrives. */
  const [sent, setSent] = useState<{ id: string; key: string } | null>(null);
  const [confirmSurrender, setConfirmSurrender] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [table, setTable] = useState<HTMLDivElement | null>(null);
  const look = useBoardSize(table);
  const ready = usePreload(shown?.view ?? null, look.imageSize);
  /** A choice in progress, which the arrows keep to: what you're choosing on the board, or the judge's question. */
  const restrict = CHOOSING.includes(mode.kind) || choice !== null;
  const nav = useKeyboardNav(root, restrict);
  /** The latest shortcut and Esc handling, for the one key listener below. */
  const keys = useRef<{ shortcut: (s: Shortcut) => boolean; escape: () => void }>({ shortcut: () => false, escape: () => undefined });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || typing(e)) return;
      if (e.key === 'Escape') return keys.current.escape();
      const shortcut = shortcutOf(e);
      if (shortcut && keys.current.shortcut(shortcut)) e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

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
  const answers = shown?.log.filter((e) => e.event.type === 'asked').length ?? 0;
  const ask = useMutation({
    mutationFn: (body: { text: string; card: number | null }) => api(`/duels/${duelId}/ask`, { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => setAwaiting(answers),
  });
  const escalateQuestion = useMutation({
    mutationFn: (body: { seq: number; note: string }) => api(`/duels/${duelId}/escalate`, { method: 'POST', body: JSON.stringify(body) }),
    onMutate: ({ seq }) => setEscalated((c) => [...c, seq]),
    onError: (_, { seq }) => setEscalated((c) => c.filter((x) => x !== seq)),
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
    playCue(table, cue, shown.prev, shown.view, cueMs(cue.event, 0, settings, reduceMotion) / (controls?.speed ?? 1));
    // Only a new step should play anything.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cue?.seq]);

  // Each step's sound, and a ping when the board comes to rest waiting on this player's answer.
  useEffect(() => {
    if (!cue || !shown) return;
    const sound = soundOf(cue.event, shown.view, !readOnly);
    if (sound) playSound(sound);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cue?.seq]);
  const needsAnswer = !readOnly && !!shown && !shown.cue && (choice !== null || awaitsAnswer(shown.view));
  useEffect(() => {
    if (needsAnswer) playSound('answer');
  }, [needsAnswer]);

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

  /** Ending the turn with End: through each phase left, one at a time, each with its response window. */
  const [ending, setEnding] = useState(false);
  /** The phase End last moved on from, so a board not yet caught up with that move doesn't send it twice. */
  const endedFrom = useRef<string | null>(null);
  const endingTurn = shown?.view.turn;
  useEffect(() => {
    setEnding(false);
    endedFrom.current = null;
  }, [endingTurn]);
  useEffect(() => {
    if (!ending || !shown) return;
    const v = shown.view;
    // Something was activated on the way: the player decides what to do about it.
    if (v.chain.length > 0 || v.result) return setEnding(false);
    if (shown.cue !== null || send.isPending || judging !== null || endedFrom.current === v.phase) return;
    const step = nextPhase(v.actions);
    if (!step) return;
    endedFrom.current = v.phase;
    if (step.type !== 'endTurn') return void send.mutate({ type: step.type });
    setEnding(false);
    if (step.discard > 0) setMode({ kind: 'discard', count: step.discard, chosen: [] });
    else send.mutate({ type: 'endTurn', discard: [] });
  }, [ending, shown, send, judging]);

  // A new question opens the pile its cards are in when they're all in one; an answered one closes the viewer.
  const promptId = choice?.prompt.id;
  useEffect(() => {
    setPile(choice?.onlyPile ?? null);
    answer.reset();
    // Only a new question should change the viewer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [promptId]);

  if (played.error) return <div className="duel-loading">{errorText(played.error)}</div>;
  if (!shown) return <div className="duel-loading">{replay ? 'Loading the replay…' : connected ? 'Loading the duel…' : 'Connecting…'}</div>;

  const { view, log } = shown;
  const me = view.you;
  const foe: Seat = me === 0 ? 1 : 0;
  // Nothing can be done while a step plays, a request is on its way, or the judge is at work.
  const busy = cue !== null || send.isPending || judging !== null;
  const actions: LegalAction[] = busy ? [] : view.actions;
  const has = <T extends LegalAction['type']>(type: T) => actions.find((a): a is Extract<LegalAction, { type: T }> => a.type === type);
  const actionsFor = (id: string) => actions.filter((a) => ('card' in a && a.card === id) || (a.type === 'attack' && a.attacker === id));
  /** Why this card's effects and attack that aren't offered now can't be used. */
  const notesFor = (id: string) => {
    const blocked = busy ? [] : view.blocked.filter((b) => b.card === id);
    const effects = blocked.filter((b) => b.effect !== null).length;
    return blocked.map((b) => ({
      label: b.effect === null ? "Why can't it attack?" : effects > 1 ? `Why can't I use "${short(b.text ?? '')}"?` : "Why can't I activate this?",
      reason: b.reason,
    }));
  };
  const playable = new Set(actions.flatMap((a) => ('card' in a ? [a.card] : a.type === 'attack' ? [a.attacker] : [])));
  const myHand = view.players[me].hand.map((c) => idOf(c)!);

  const myMonsters = view.players[me].monsters;
  const extraName = (id: string) => {
    const c = view.players[me].extra.find((h) => idOf(h) === id);
    return (c && dataOf(c)?.name) ?? 'the monster';
  };
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
      case 'pass':
      case 'surrender':
        return send.mutate({ type: action.type });
      case 'replace':
        return send.mutate({ type: 'replace', materials: action.materials.slice(0, action.count) });
      case 'tax':
        return send.mutate({ type: 'tax', discard: null });
      case 'rollback':
        return send.mutate({ type: 'rollback', accept: true });
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

  /**
   * Placing with several possible actions (Summon or Set) asks which, right where the card was dropped. So does an
   * activation even when it is the only option: while you hold priority a card can't be Set, and a drop meant as a
   * Set must not activate it.
   */
  function placeAt(options: Placeable[], zone: number, anchor: HTMLElement): boolean {
    if (options.length === 1 && options[0]!.type !== 'activate') place(options[0]!, zone);
    else if (options.length > 0) setMode({ kind: 'place', options, zone, anchor });
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
    if (mode.kind === 'materials' && (mode.chosen.includes(id) || materialFits(mode, id))) {
      const chosen = toggle(mode.chosen, id);
      const option = mode.action.options.find((o) => o.materials.length === chosen.length && o.materials.every((m) => chosen.includes(m)));
      if (!option) return setMode({ ...mode, chosen });
      if (option.zones.length === 1) return summonFromExtra(mode.action, mode.position, chosen, option.zones[0]!);
      return setMode({ kind: 'extraZone', action: mode.action, position: mode.position, materials: chosen, zones: option.zones });
    }
    if (mode.kind === 'discard' && myHand.includes(id)) {
      const chosen = toggle(mode.chosen, id);
      if (chosen.length === mode.count) return send.mutate({ type: 'endTurn', discard: chosen });
      return setMode({ ...mode, chosen });
    }
    if (mode.kind === 'menu' && mode.id === id) return setMode(idle);
    setMode(actionsFor(id).length > 0 || notesFor(id).length > 0 ? { kind: 'menu', id, anchor } : idle);
  }

  /** Whether a monster can join the materials picked so far: some set of materials holds them all and it. */
  function materialFits(m: Extract<Mode, { kind: 'materials' }>, id: string) {
    return m.action.options.some((o) => o.materials.includes(id) && m.chosen.every((c) => o.materials.includes(c)));
  }

  function summonFromExtra(action: ExtraSummon, position: Position, materials: string[], zone: number) {
    send.mutate({ type: 'extraSummon', card: action.card, materials, zone, position });
  }

  /** Whether a zone can be picked now, by click or drop. */
  function zoneState(seat: Seat, row: Row, zone: number): 'open' | 'over' | null {
    let open = false;
    // The zone a card was just dropped on stays lit while you pick Summon or Set.
    if (seat === me && mode.kind === 'place' && mode.zone === zone && fitsZone(mode.options, row, zone).length > 0) return 'over';
    if (seat === me) {
      const options = drag?.kind === 'card' ? placeables(drag.id) : mode.kind === 'zone' ? [mode.action] : [];
      open =
        fitsZone(options, row, zone).length > 0 ||
        (mode.kind === 'extraZone' && row === 'm' && mode.zones.includes(zone)) ||
        (row === 'm' && (choice?.prompt.zones.includes(zone) ?? false));
    } else if (row === 'm') {
      const attack = drag?.kind === 'aim' ? drag.action : mode.kind === 'target' ? mode.action : null;
      open = attack?.targets.includes(zone) ?? false;
    }
    return open ? (over === dropKey(seat, row, zone) ? 'over' : 'open') : null;
  }

  function clickZone(seat: Seat, row: Row, zone: number) {
    if (seat === me && row === 'm' && choice?.prompt.zones.includes(zone) && !answer.isPending) {
      return answer.mutate({ prompt: choice.prompt.id, picks: [zonePick(zone)] });
    }
    if (seat === me && mode.kind === 'zone' && fitsZone([mode.action], row, zone).length > 0) place(mode.action, zone);
    if (seat === me && mode.kind === 'extraZone' && row === 'm' && mode.zones.includes(zone)) summonFromExtra(mode.action, mode.position, mode.materials, zone);
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

  const choosing = CHOOSING.includes(mode.kind);
  const pickable = (id: string) =>
    (mode.kind === 'tributes' && mode.action.tributeFrom.includes(id)) ||
    (mode.kind === 'discard' && myHand.includes(id)) ||
    (mode.kind === 'materials' && !mode.chosen.includes(id) && materialFits(mode, id));
  const marks: CardMarks = {
    classes: (id) =>
      id === null
        ? ''
        : [
            mode.kind === 'menu' && mode.id === id && 'selected',
            (mode.kind === 'tributes' || mode.kind === 'discard' || mode.kind === 'materials') && mode.chosen.includes(id) && 'picked',
            mode.kind === 'extraZone' && mode.materials.includes(id) && 'picked',
            pickable(id) && 'pickable',
            mode.kind === 'target' && mode.action.attacker === id && 'selected',
            drag?.kind === 'aim' && drag.action.attacker === id && 'selected',
            mode.kind === 'zone' && mode.action.card === id && 'selected',
            !choosing && playable.has(id) && 'playable',
            highlight.includes(id) && 'highlight',
          ]
            .filter(Boolean)
            .join(' '),
    pickable: (id) => id !== null && (pickable(id) || ((mode.kind === 'tributes' || mode.kind === 'discard' || mode.kind === 'materials') && mode.chosen.includes(id))),
  };

  const prompt = choosing && (
    <span className="choice-prompt">
      {mode.kind === 'tributes' && `Choose ${plural(mode.action.tributes - mode.chosen.length, 'monster')} to Tribute.`}
      {mode.kind === 'target' && "Choose one of your opponent's monsters to attack."}
      {mode.kind === 'zone' && `Choose a zone for ${cardName(mode.action.card)}.`}
      {mode.kind === 'materials' && materialsPrompt(mode.action, extraName(mode.action.card))}
      {mode.kind === 'extraZone' && `Choose a zone for ${extraName(mode.action.card)}.`}
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

  const escalate: Escalate = {
    can: (seq) => !escalated.includes(seq) && !log.some((e) => e.event.type === 'escalated' && e.event.asked === seq),
    send: (seq, note) => escalateQuestion.mutate({ seq, note }),
  };
  const contest: Contest = {
    can: (seq) => !contested.includes(seq) && !log.some((e) => e.event.type === 'appealed' && e.event.judged === seq),
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
        return { title: `${whose} Extra Deck`, cards: side.extra, mine: Number(seat) === me };
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

  /**
   * A response window or optional triggers: the player whose turn it is to answer gets the question and a Pass
   * button (the cards they can activate glow); the other player sees whom the duel waits on.
   */
  const waiting = view.waiting;
  const pass = has('pass');
  const replace = has('replace');
  /** An overturned ruling's rewind offer: both players must accept. */
  const offer = view.rollback;
  const rollbackNote = offer && (
    <span className="choice-prompt" role="group">
      <span className="choice-text long" title={offer.explanation}>
        Ruling overturned: {offer.explanation}{' '}
        <strong>
          {has('rollback')
            ? offer.accepted.length
              ? `${view.players[offer.accepted[0]!].name} wants to rewind to before it, undoing everything since.`
              : 'Rewind to before it? Both players must agree.'
            : `Waiting for ${view.players[me === 0 ? 1 : 0].name} to answer…`}
        </strong>
      </span>
      {has('rollback') && (
        <>
          <button className="primary" onClick={() => send.mutate({ type: 'rollback', accept: true })}>
            Rewind
          </button>
          <button onClick={() => send.mutate({ type: 'rollback', accept: false })}>Keep playing</button>
        </>
      )}
    </span>
  );
  const replacing = replace && myMonsters.find((m) => m && idOf(m.card) === replace.card);
  const materialName = (id: string) => {
    const c = replacing?.materials.find((m) => idOf(m) === id);
    return (c && dataOf(c)?.name) ?? 'a material';
  };
  /** A monster that would be destroyed and can detach materials instead: one button per material it could detach. */
  const replaceNote = replace && (
    <span className="choice-prompt" role="group">
      <span className="choice-text">
        {(replacing && dataOf(replacing.card)?.name) ?? 'Your monster'} would be destroyed. Detach instead?
      </span>
      {replace.count === 1 ? (
        [...new Map(replace.materials.map((m) => [materialName(m), m])).entries()].map(([name, m]) => (
          <button key={m} className="primary" onClick={() => send.mutate({ type: 'replace', materials: [m] })}>
            Detach {name}
          </button>
        ))
      ) : (
        <button className="primary" onClick={() => start(replace)}>
          Detach {replace.count}
        </button>
      )}
      <button onClick={() => send.mutate({ type: 'replace', materials: [] })}>Let it be destroyed</button>
    </span>
  );
  const topLink = view.chain.at(-1);
  const tax = has('tax');
  /** General Raiho: discard 1 card (one button per card name in hand) or let the resolving effect be negated. */
  const taxNote = tax && (
    <span className="choice-prompt" role="group">
      <span className="choice-text">
        {waiting?.cause ?? 'A card'}: discard 1 card, or {(topLink && dataOf(topLink.card)?.name) ?? 'your monster'}'s effect is negated.
      </span>
      {[...new Map(tax.hand.map((id) => [cardName(id), id])).entries()].map(([name, id]) => (
        <button key={id} className="primary" onClick={() => send.mutate({ type: 'tax', discard: id })}>
          Discard {name}
        </button>
      ))}
      <button onClick={() => send.mutate({ type: 'tax', discard: null })}>Let it be negated</button>
    </span>
  );
  /** Whether this player may respond now with something; with nothing, the window closes by itself once the response floor has passed. */
  const canRespond = !!waiting && waiting.player === me && !!pass && (waiting.for !== 'respond' || actions.some((a) => a.type === 'activate'));
  const respondNote = waiting && waiting.player === me && pass && canRespond && (
    <span className="choice-prompt" role="group">
      <span className="choice-text">
        {waiting.for === 'triggers'
          ? 'Activate a trigger effect?'
          : topLink
            ? `Respond to ${dataOf(topLink.card)?.name ?? 'the chain'}?`
            : `Respond to ${waiting.cause ?? 'this'}?`}
      </span>
      <button className="primary" onClick={() => start(pass)}>
        {waiting.for === 'triggers' ? "Don't activate" : 'Pass'}
      </button>
    </span>
  );
  /** Whom the duel waits on, when it isn't this player's decision. */
  const waitNote =
    waiting &&
    !canRespond &&
    (waiting.player === me ? (
      <span className="judging" role="status">
        <span className="dot" />
        No response to {topLink ? (dataOf(topLink.card)?.name ?? 'the chain') : (waiting.cause ?? 'this')}, moving on…
      </span>
    ) : (
      <span className="judging" role="status">
        <span className="dot" />
        Waiting for {view.players[waiting.player].name}…
      </span>
    ));
  /** The chain waiting to resolve, link 1 first. */
  const chainNote = view.chain.length > 0 && (
    <span className="chain-list" aria-label="Chain">
      {view.chain.map((l, i) => (
        <span key={i} className={l.player === me ? 'mine' : 'theirs'}>
          {i + 1}. {dataOf(l.card)?.name ?? 'a card'}
        </span>
      ))}
    </span>
  );

  const lpTarget = (): 'open' | 'over' | null => {
    const attack = drag?.kind === 'aim' ? drag.action : null;
    return attack?.direct ? (over === `lp:${foe}` ? 'over' : 'open') : null;
  };

  const foeField: FieldProps = {
    seat: foe,
    side: view.players[foe],
    mine: false,
    turned: opponentCards === 'faceThem',
    marks,
    zoneState: (row, zone) => zoneState(foe, row, zone),
    onZone: (row, zone) => clickZone(foe, row, zone),
    onCard: () => undefined,
    onPile: (place) => setPile(pileKey(foe, place)),
  };
  const myField: FieldProps = {
    seat: me,
    side: view.players[me],
    mine: true,
    marks,
    zoneState: (row, zone) => zoneState(me, row, zone),
    onZone: (row, zone) => clickZone(me, row, zone),
    onCard: clickOwn,
    onCardPress: pressOwn,
    onPile: (place) => setPile(pileKey(me, place)),
    extraPlayable: actions.some((a) => a.type === 'extraSummon'),
  };

  const yourTurn = view.turnPlayer === me && !view.result && !view.start;
  const enterBattle = has('enterBattle');
  const enterMain2 = has('enterMain2');
  const endTurn = has('endTurn');
  const canSurrender = !readOnly && !view.result;
  const result = view.result;
  const resultText = log.findLast((e) => e.event.type === 'duelEnded')?.text;
  const turnLabel = <TurnLabel turn={view.turn} label={view.start ? 'Deciding who goes first' : yourTurn && !readOnly ? 'Your turn' : `${view.players[view.turnPlayer].name}'s turn`} />;
  const nextStep = choosing ? undefined : nextPhase(actions);
  const canEnd = yourTurn && !choosing && view.chain.length === 0 && nextPhase(view.actions) !== undefined;
  const dial = (
    <PhaseDial
      phase={view.phase}
      goTo={{
        ...(enterBattle && { battle: () => start(enterBattle) }),
        ...(enterMain2 && { main2: () => start(enterMain2) }),
        ...(endTurn && { end: () => start(endTurn) }),
      }}
      next={nextStep && !ending ? () => start(nextStep) : null}
      end={ending ? () => setEnding(false) : canEnd ? () => setEnding(true) : null}
      ending={ending}
      readOnly={readOnly}
    />
  );
  /** A decision the duel waits on this player for: in a popup over the field, never squeezed into the strip. */
  const decision = readOnly ? null : choiceBar || rollbackNote || replaceNote || taxNote || respondNote || null;
  const decisionId = choice ? choice.prompt.id : rollbackNote ? 'rollback' : replaceNote ? `replace:${replace.card}` : taxNote ? 'tax' : `respond:${view.chain.length}:${waiting?.cause ?? ''}`;
  // Kept off the cards being picked: over your own field when any of them are on the opponent's.
  const decisionOver = choice?.prompt.cards.some((o) => o.seat === foe && o.zone !== null) ? 'mine' : 'foe';
  const decisionPopup = decision && !openPile && (
    <DecisionPopup id={decisionId} over={decisionOver}>
      {decision}
    </DecisionPopup>
  );
  const stripPrompt = prompt || (readOnly && rollbackNote) || judgeNote || waitNote || null;

  /** Runs a shortcut (docs/keyboard.md); false when it does nothing now, so the key keeps its usual meaning. */
  function shortcut(key: Shortcut): boolean {
    if (key === 'help') return (setShowKeys(true), true);
    if (key === 'log') return nav.focusArea('log', true);
    if (key === 'mute') return (updateSettings({ muted: !settings.muted }), true);
    if (readOnly) return false;
    switch (key) {
      case 'pass':
        // With nothing to respond with, the window closes by itself, as the disabled Pass button says.
        if (!pass || waiting?.player !== me || (waiting.for === 'respond' && !actions.some((a) => a.type === 'activate'))) return false;
        return (start(pass), true);
      case 'next':
        return nextStep !== undefined && !ending && (start(nextStep), true);
      case 'end':
        return canEnd && !ending && (setEnding(true), true);
      case 'confirm':
        if (!choice?.complete || choice.prompt.zones.length > 0 || answer.isPending) return false;
        return (answer.mutate({ prompt: choice.prompt.id, picks: choice.picks }), true);
      case 'chat':
      case 'ask':
        setAsking(key === 'ask' ? { about: null } : null);
        bumpChatFocus();
        return true;
    }
  }
  keys.current = {
    shortcut,
    // Esc backs out of a choice on the board, once nothing is open over it (a menu, a pile, the keys).
    escape: () => {
      if (choosing && !pile && !showKeys) setMode(idle);
    },
  };

  return (
    <MotionConfig reducedMotion={reduceMotion ? 'always' : 'never'}>
      <BoardLookProvider value={look}>
        <ChoiceProvider value={choice}>
          <CardTooltipProvider
            suppressed={choosing || drag !== null || mode.kind === 'menu' || mode.kind === 'place'}
            pinnedFooter={readOnly ? undefined : (card) => (
              <>
                <button
                  className="quiet report-ruling"
                  onClick={() => {
                    setAsking({ about: card });
                    bumpChatFocus();
                  }}
                >
                  Ask the judge about this card
                </button>
                <ReportRuling key={card.code} duelId={duelId} card={card} />
              </>
            )}
          >
            <div ref={setRoot} className={`duel${look.stacked ? ' stacked' : ''}${look.compact ? ' compact' : ''}${look.tight ? ' tight' : ''}${look.typing ? ' typing' : ''}${choosing || choice ? ' choosing' : ''}${drag ? ' dragging' : ''}${smallFrame ? ' small-frame' : ''}`} style={{ '--zone': `${look.zone}px` } as React.CSSProperties}>
              {smallFrame && (
                // Discord's pop-out or grid tile is too small for the board: just the score, until it's full size again.
                <div className="small-frame-summary">
                  <p>
                    {turnLabel}
                    {!view.start && <span className="muted"> · {phaseName(view.phase)}</span>}
                  </p>
                  {[foe, me].map((seat) => (
                    <p key={seat} className={!view.start && view.turnPlayer === seat ? 'active' : undefined}>
                      <span>{view.players[seat].name}</span> <strong>LP {view.players[seat].lp}</strong>
                    </p>
                  ))}
                </div>
              )}
              <div className="table" ref={setTable}>
                {!ready ? (
                  <div className="duel-loading">Loading cards…</div>
                ) : (
                  <>
                    <div className="hand-row foe-row">
                      <LpPlate seat={foe} name={view.players[foe].name} lp={view.players[foe].lp} cue={cue} active={!view.start && view.turnPlayer === foe} target={lpTarget()} />
                      <ReadOnlyHand seat={foe} name={view.players[foe].name} cards={view.players[foe].hand} side="top" />
                    </div>
                    <Field {...foeField} />
                    <PhaseStrip
                      yours={yourTurn}
                      side={
                        look.compact ? null : (
                          <div className="strip-side">
                            {turnLabel}
                            {chainNote}
                          </div>
                        )
                      }
                      extraZones={[<ExtraMonsterZone key="left" side="left" mine={myField} foe={foeField} />, <ExtraMonsterZone key="right" side="right" mine={myField} foe={foeField} />]}
                      middle={look.compact ? chainNote || null : dial}
                      prompt={look.compact ? null : stripPrompt}
                      decision={decisionPopup}
                    />
                    <Field {...myField} />
                    <div className="hand-row own-row">
                      <LpPlate seat={me} name={view.players[me].name} lp={view.players[me].lp} cue={cue} active={!view.start && view.turnPlayer === me} />
                      {watching === 'live' ? (
                        <ReadOnlyHand seat={me} name={view.players[me].name} cards={view.players[me].hand} side="bottom" />
                      ) : (
                      <OwnHand
                        duelId={duelId}
                        seat={me}
                        cards={view.players[me].hand}
                        marks={marks}
                        onCard={clickOwn}
                        drag={handDrag}
                        held={held}
                        moving={moving}
                        onMoved={() => setMoving(null)}
                      />
                      )}
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
                      {cue.event.player === me && !readOnly ? 'Your turn' : `${view.players[cue.event.player].name}'s turn`}
                    </motion.div>
                  )}
                </AnimatePresence>

                {ready && view.start && !result && (
                  <StartPanel start={view.start} view={view} can={has(view.start.at === 'rps' ? 'rps' : 'chooseOrder') !== undefined} send={(intent) => send.mutate(intent)} />
                )}

                {result && cue === null && !replay && (
                  <motion.div className="result-overlay" data-area="strip" initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }}>
                    <strong>
                      {result.winner === null ? 'Draw' : readOnly ? `${view.players[result.winner].name} wins` : result.winner === me ? 'Victory' : 'Defeat'}
                    </strong>
                    {resultText && <span>{resultText}</span>}
                    <span className="row">
                      <Link className="button" to={`/duel/${duelId}/replay`}>
                        Watch the replay
                      </Link>
                      <Link className="button" to="/">
                        Back to duels
                      </Link>
                    </span>
                  </motion.div>
                )}
              </div>

              {look.compact && ready && (
                <div className={`duel-bar${yourTurn ? ' yours' : ''}`} data-area="strip">
                  <div className="bar-turn">
                    {turnLabel}
                    {dial}
                  </div>
                  {stripPrompt && <div className="bar-prompt">{stripPrompt}</div>}
                </div>
              )}

              <aside className="panel">
                <div className="row panel-top">
                  <Link to="/">← Duels</Link>
                  <span className="spacer" />
                  <CopyLink path={replay ? `/duel/${duelId}/replay` : `/duel/${duelId}`} label="Share" />
                  <button
                    className="quiet"
                    onClick={() => updateSettings({ muted: !settings.muted })}
                    aria-pressed={settings.muted}
                    title={settings.muted ? 'Sound off (M)' : 'Sound on (M)'}
                    aria-label="Mute"
                  >
                    {settings.muted ? '🔇' : '🔊'}
                  </button>
                  <button className="quiet" onClick={() => setShowSettings((s) => !s)} aria-expanded={showSettings}>
                    Settings
                  </button>
                  {canSurrender && !confirmSurrender && (
                    <button className="quiet" onClick={() => setConfirmSurrender(true)}>
                      Surrender
                    </button>
                  )}
                </div>
                <DuelSwitcher enabled={canPlay} />
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
                    <label>
                      Sound volume{' '}
                      <input
                        type="range"
                        min={0}
                        max={1}
                        step={0.05}
                        value={settings.muted ? 0 : settings.volume}
                        onChange={(e) => updateSettings({ volume: Number(e.target.value), muted: false })}
                        onPointerUp={() => playSound('activate')}
                      />
                    </label>
                    {hasAccount && <OpponentCardsSetting />}
                    {!readOnly && <NotifySetting />}
                    <p className="muted small">Hold Shift over a card to zoom in. Right-click a card, or press and hold it, to pin its details. Drag cards in your hand to reorder them. Press ? for the keyboard controls.</p>
                  </div>
                )}
                {!connected && <p className="error">Reconnecting…</p>}
                {send.isError && <p className="error">{errorText(send.error)}</p>}
                {contestRuling.isError && <p className="error">{errorText(contestRuling.error)}</p>}
                {chat.isError && <p className="error">{errorText(chat.error)}</p>}
                {ask.isError && <p className="error">{errorText(ask.error)}</p>}
                {escalateQuestion.isError && <p className="error">{errorText(escalateQuestion.error)}</p>}
                <DuelLog log={log} onHighlight={setHighlight} contest={readOnly ? never : contest} escalate={readOnly ? never : escalate} />
                {controls ? (
                  <ReplayBar controls={controls} names={[view.players[0].name, view.players[1].name]} />
                ) : watching === 'live' ? (
                  <WatchBar from={watchFrom} setFrom={setWatchFrom} names={[view.players[0].name, view.players[1].name]} />
                ) : (
                  <ChatInput
                    send={chat.mutateAsync}
                    ask={(text, card) => ask.mutateAsync({ text, card })}
                    sending={chat.isPending || ask.isPending}
                    answering={awaiting !== null && answers <= awaiting}
                    asking={asking}
                    onAsking={setAsking}
                    focus={chatFocus}
                  />
                )}
              </aside>

              {mode.kind === 'menu' && (
                <ActionMenu
                  anchor={mode.anchor}
                  items={[...actionsFor(mode.id).flatMap((a) =>
                    a.type === 'extraSummon'
                      ? (['attack', 'defense'] as const).map((position) => ({
                          label: `${a.how === 'synchro' ? 'Synchro' : 'Xyz'} Summon in ${position === 'attack' ? 'Attack' : 'Defense'} Position`,
                          run: () => {
                            setPile(null);
                            setMode({ kind: 'materials', action: a, position, chosen: [] });
                          },
                        }))
                      : [{ label: actionLabel(a, view), run: () => start(a) }],
                  ),
                  // Reordering the hand by keyboard, where dragging isn't available.
                  ...(myHand.includes(mode.id) && nav.usingKeyboard() && !readOnly ? [{ label: 'Move in hand', run: () => (setMode(idle), setMoving(mode.id)) }] : [])]}
                  notes={notesFor(mode.id)}
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
              {showKeys && <KeyHelp onClose={() => setShowKeys(false)} />}
              {openPile && (
                <PileViewer
                  title={openPile.title}
                  cards={openPile.cards}
                  bar={choiceBar}
                  onClose={() => setPile(null)}
                  playable={'mine' in openPile && openPile.mine && !choice ? (id) => playable.has(id) : undefined}
                  onCard={(id, anchor) => setMode({ kind: 'menu', id, anchor })}
                />
              )}
            </div>
          </CardTooltipProvider>
        </ChoiceProvider>
      </BoardLookProvider>
    </MotionConfig>
  );
}

/**
 * Loads the images of your own deck before the board appears, so cards don't pop in mid-duel. The opponent's cards
 * load as they're revealed, since their decklist isn't yours to know; a spectator knows neither, so loads none first.
 */
function usePreload(view: PlayerView | null, size: 'small' | 'full') {
  const [ready, setReady] = useState(false);
  const deckList = view?.deckList.join();
  useEffect(() => {
    if (deckList === undefined) return;
    if (deckList === '') return setReady(true);
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

/** What a Synchro or Xyz Summon needs, while its materials are picked on the board. */
function materialsPrompt(action: ExtraSummon, name: string) {
  return action.how === 'synchro' ? `Choose a Tuner and non-Tuner monsters whose Levels add up to ${name}'s Level.` : `Choose the Xyz Materials for ${name}.`;
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
    case 'replace':
      return 'Detach instead of being destroyed';
    case 'tax':
      return 'Let the effect be negated';
    case 'rollback':
      return 'Rewind';
    case 'activate': {
      // A card with one effect to activate just says so; with several, each names its own.
      const several = view.actions.filter((o) => o.type === 'activate' && o.card === a.card).length > 1;
      return several ? `Activate: ${a.text.length > 60 ? `${a.text.slice(0, 57)}…` : a.text}` : 'Activate';
    }
    default:
      return a.type;
  }
}

/** Nothing can be contested or escalated by someone watching. */
const never = { can: () => false, send: () => undefined };

const toggle = (list: string[], id: string) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);
const plural = (n: number, word: string) => `${n} more ${word}${n === 1 ? '' : 's'}`;

/** What Next does: move on to the next phase, or end the turn from the last one. */
function nextPhase(actions: LegalAction[]) {
  for (const type of ['enterBattle', 'enterMain2', 'endTurn'] as const) {
    const action = actions.find((a): a is Extract<LegalAction, { type: typeof type }> => a.type === type);
    if (action) return action;
  }
  return undefined;
}

/** The start of an effect's wording, short enough for a menu item. */
function short(text: string): string {
  return text.length > 48 ? `${text.slice(0, 45).trimEnd()}…` : text;
}
