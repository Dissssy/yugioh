// The duel's data: card facts, the event log, the state it folds into, and what players may ask for.

export type Seat = 0 | 1;

/** What the engine knows about a card. Copied into the log when a duel starts, so replays never depend on later errata. */
export interface CardData {
  code: number;
  name: string;
  /** YGOPRODeck's type line, e.g. "Normal Tuner Monster". */
  type: string;
  kind: 'monster' | 'spell' | 'trap';
  /** Monsters that live in the Extra Deck (Fusion, Synchro, Xyz, Link). */
  extraDeck: boolean;
  text: string;
  level: number | null;
  atk: number | null;
  def: number | null;
  attribute: string | null;
  /** Monster type ("Warrior"), or for Spells and Traps their property ("Normal", "Quick-Play", "Continuous", "Equip", "Field", "Counter"). */
  race: string;
}

/** How one effect of a card works, read once from its text by a strong model (see docs/effects.md). */
export interface SheetEffect {
  /**
   * `activation`: activating the Spell/Trap card itself. `ignition`, `trigger`, `quick`, `flip`: monster effects.
   * `continuous`: always on, never activated. `condition`: a summoning condition or procedure.
   */
  kind: 'activation' | 'ignition' | 'trigger' | 'quick' | 'continuous' | 'flip' | 'condition';
  speed: 1 | 2 | 3;
  /** For triggers: whether the controller must activate it. */
  mandatory: boolean;
  /** `soft`: once per turn for each copy. `hard`: once per turn for all copies by card name. */
  opt: 'none' | 'soft' | 'hard';
  /** When it can be used, in plain words. */
  window: string;
  /** The cost, as worded on the card, or empty. */
  cost: string;
  /** What it does, as worded on the card. */
  effect: string;
  /** What it targets, or null if it doesn't target. */
  targets: string | null;
}

export interface EffectSheet {
  code: number;
  /** sha256 of the card text the sheet was made from; a sheet whose hash no longer matches is ignored. */
  textHash: string;
  /** Made by `model`; set to true by a person who checked it, after which the compiler never overwrites it. */
  verified: boolean;
  model: string;
  effects: SheetEffect[];
  /** Extra Deck materials as worded on the card, or null. */
  materials: string | null;
}

export type Phase = 'draw' | 'standby' | 'main1' | 'battle' | 'main2' | 'end';
export type Position = 'attack' | 'defense';

/** A change to a face-up monster's stats. Every modifier ends when the card leaves the field. */
export interface Modifier {
  card: string;
  /** Who applied it, for "your next Standby Phase". */
  player: Seat;
  atk: number;
  def: number;
  /** Added to the Level. */
  levelDelta: number;
  /** The Level becomes this, before levelDelta of later modifiers. */
  levelSet: number | null;
  until: Until;
  turn: number;
}

export const UNTIL = ['end_of_turn', 'end_of_battle_phase', 'next_standby_phase', 'while_on_field'] as const;
export type Until = (typeof UNTIL)[number];

/** An activated effect waiting to resolve. Layer 2 has no responses, so the chain never holds more than one link. */
export interface ChainLink {
  player: Seat;
  card: string;
  effect: number;
  targets: string[];
  /** The effect chosen on activation when the text offers several ("Activate 1 of these effects"), as the judge worded it. */
  choice: string | null;
}

/** A card on the field. */
export interface FieldCard {
  id: string;
  position: Position;
  faceUp: boolean;
  /** Turn it arrived on the field, for "not the turn it was summoned or set". */
  placedTurn: number;
  /** Last turn its position changed, by a change of position or a Flip Summon. */
  positionChangedTurn: number | null;
  attackedTurn: number | null;
}

export type Zones = (FieldCard | null)[];

export interface PlayerState {
  name: string;
  lp: number;
  /** Top of the deck first. */
  deck: string[];
  hand: string[];
  monsters: Zones;
  spellTraps: Zones;
  graveyard: string[];
  banished: string[];
  extra: string[];
}

export interface DuelState {
  /** Card instances by ID. Instance IDs are random so an ID never reveals which card it is. */
  instances: Record<string, { code: number; owner: Seat }>;
  cards: Record<number, CardData>;
  /** Effect sheets of the cards in the duel that have effects. */
  sheets: Record<number, EffectSheet>;
  players: [PlayerState, PlayerState];
  turn: number;
  turnPlayer: Seat;
  phase: Phase;
  normalSummons: number;
  /** Normal Summons/Sets allowed this turn: 1, or more after an effect like Double Summon. */
  normalSummonLimit: number;
  modifiers: Modifier[];
  chain: ChainLink[];
  /** Effects used this turn, for once-per-turn clauses. */
  usedThisTurn: { card: string; code: number; effect: number }[];
  /**
   * Rulings on activations that stand for the board as it is now, until any event changes it (another illegal ruling
   * or an appeal changes nothing). An activation the judge ruled illegal is refused without asking it again
   * (`legal` false, the judge's summary); once an appeal overturns that, the next try must be ruled legal (`legal`
   * true, the appeal's ruling, which the judge is given).
   */
  rulings: { player: Seat; card: string; effect: number; legal: boolean; summary: string }[];
  result: DuelResult | null;
}

export interface DuelResult {
  winner: Seat | null;
  reason: 'lp' | 'deckOut' | 'surrender';
}

export const MONSTER_ZONES = 5;
export const SPELL_TRAP_ZONES = 5;
export const STARTING_LP = 8000;
export const OPENING_HAND = 5;
export const HAND_LIMIT = 6;

/** What a player asks for. Own cards are named by instance ID; opponent's monsters by zone, since a face-down card has no ID in their view. */
export type Intent =
  | { type: 'normalSummon'; card: string; tributes: string[]; zone: number }
  | { type: 'setMonster'; card: string; tributes: string[]; zone: number }
  | { type: 'setSpellTrap'; card: string; zone: number }
  | { type: 'flipSummon'; card: string }
  | { type: 'changePosition'; card: string }
  | { type: 'enterBattle' }
  | { type: 'attack'; attacker: string; target: number | 'direct' }
  | { type: 'enterMain2' }
  | { type: 'endTurn'; discard: string[] }
  /** Activates effect `effect` (an index into the card's effect sheet). `zone` is where a Spell/Trap from the hand goes. */
  | { type: 'activate'; card: string; effect: number; zone: number | null }
  | { type: 'surrender' };

/** Where an op sends a card. Deck places shuffle the Deck, except the top and bottom. */
export const DESTINATIONS = ['hand', 'deck_top', 'deck_bottom', 'deck_shuffled', 'graveyard', 'banished'] as const;
export type Destination = (typeof DESTINATIONS)[number];

/**
 * The closed set of changes the judge can make. Code checks each one against the board before it applies.
 * Card references are instance IDs, so the model can't invent a card.
 */
export type Op =
  | { op: 'move'; card: string; to: Destination }
  | { op: 'special_summon'; card: string; controller: Seat; position: Position }
  | { op: 'destroy'; cards: string[] }
  | { op: 'change_lp'; player: Seat; amount: number; kind: 'damage' | 'cost' | 'gain' }
  | { op: 'modify_stats'; card: string; atk: number; def: number; level_delta: number; level_set: number | null; until: Until }
  | { op: 'change_position'; card: string; position: Position }
  | { op: 'draw'; player: Seat; count: number }
  | { op: 'extra_normal_summon'; player: Seat }
  | { op: 'declare_targets'; cards: string[] }
  | { op: 'choose_effect'; choice: string };

/** One judge call, kept whole so it can be contested and replayed. Players see only `stage`, `legal` and `summary`. */
export interface JudgeRecord {
  stage: 'activation' | 'resolution';
  player: Seat;
  card: string;
  effect: number;
  model: string;
  promptVersion: string;
  /** sha256 of the state the judge saw. */
  stateHash: string;
  /** The conversation after the system prompt, exactly as sent and received. */
  transcript: unknown[];
  /** For `activation`, whether the activation was allowed. Always true for `resolution`. */
  legal: boolean;
  /** One line for both players' logs. */
  summary: string;
  ops: Op[];
  /** Set when the judge failed (an API error, or no answer within the turn limit); the activation is refused or the effect does nothing. */
  error: string | null;
}

/** A stronger model's second look at a judge decision. */
export interface AppealRecord {
  /** Event index of the contested `judged` event. */
  judged: number;
  /** Which decision that was. */
  decision: Pick<JudgeRecord, 'stage' | 'player' | 'card' | 'effect' | 'legal'>;
  by: Seat;
  note: string;
  model: string;
  verdict: 'upheld' | 'overturned';
  /** One or two sentences for both players; checked to name no card hidden from either. */
  explanation: string;
  /** The correct ruling, kept for review as a candidate ruling. Never shown, since it may mention hidden cards. */
  ruling: string;
}

/** Everything that happens is one of these. The duel's state is the fold of its events. */
export type DuelEvent =
  | {
      type: 'duelStarted';
      cards: Record<number, CardData>;
      sheets: Record<number, EffectSheet>;
      instances: Record<string, { code: number; owner: Seat }>;
      /** Decks already shuffled, top first. */
      players: [StartingPlayer, StartingPlayer];
      first: Seat;
    }
  | { type: 'intent'; player: Seat; intent: Intent }
  | { type: 'turnStarted'; player: Seat; turn: number }
  | { type: 'phaseChanged'; phase: Phase }
  | { type: 'drew'; player: Seat; count: number }
  | { type: 'tributed'; player: Seat; cards: string[] }
  | { type: 'normalSummoned'; player: Seat; card: string; zone: number }
  | { type: 'monsterSet'; player: Seat; card: string; zone: number }
  | { type: 'spellTrapSet'; player: Seat; card: string; zone: number }
  | { type: 'flipSummoned'; player: Seat; card: string }
  | { type: 'positionChanged'; player: Seat; card: string; position: Position }
  | { type: 'attackDeclared'; player: Seat; attacker: string; target: string | null }
  | { type: 'flippedByAttack'; card: string }
  | { type: 'battleDamage'; player: Seat; amount: number }
  | { type: 'destroyedByBattle'; cards: string[] }
  | { type: 'discarded'; player: Seat; cards: string[] }
  | { type: 'judged'; record: JudgeRecord }
  /** A Spell/Trap from the hand goes face-up to `zone`; a Set one flips face-up; a monster's effect leaves it where it is. */
  | { type: 'effectActivated'; player: Seat; card: string; effect: number; zone: number | null }
  | { type: 'targeted'; cards: string[] }
  | { type: 'effectChosen'; choice: string }
  | { type: 'moved'; card: string; owner: Seat; from: Place; to: Destination }
  | { type: 'deckShuffled'; player: Seat; order: string[] }
  | { type: 'specialSummoned'; player: Seat; card: string; zone: number; position: Position }
  | { type: 'destroyed'; cards: string[] }
  | { type: 'lpChanged'; player: Seat; amount: number; kind: 'damage' | 'cost' | 'gain' }
  | { type: 'statsModified'; modifier: Modifier }
  | { type: 'normalSummonGranted'; player: Seat }
  /** The chain link resolved: it leaves the chain, and a Normal or Quick-Play Spell or Normal Trap goes to the GY. */
  | { type: 'linkResolved' }
  | { type: 'appealed'; appeal: AppealRecord }
  | { type: 'duelEnded'; result: DuelResult }
  /** A player's chat message. It changes nothing on the board and never reaches the judge. */
  | { type: 'chatted'; player: Seat; text: string };

export interface StartingPlayer {
  name: string;
  deck: string[];
  extra: string[];
}

/** The board as one player sees it. Hidden cards carry no ID and no card data. */
export interface PlayerView {
  you: Seat;
  /** Every distinct card in the viewer's own Deck and Extra Deck, so the client can load their images up front. */
  deckList: number[];
  turn: number;
  turnPlayer: Seat;
  phase: Phase;
  normalSummonUsed: boolean;
  result: DuelResult | null;
  players: [PlayerSideView, PlayerSideView];
  /** Activated effects waiting to resolve, oldest first. */
  chain: { player: Seat; card: CardView; effect: number; targets: string[]; choice: string | null }[];
  actions: LegalAction[];
}

/**
 * An event as one player may see it: a card Set by the opponent has no ID, nor does a card moving between places
 * the player can't see. Intents, the duel's start and Deck orders are never shown, and a judge decision shows only its outcome.
 */
export type LogEvent =
  | Exclude<
      DuelEvent,
      { type: 'duelStarted' | 'intent' | 'monsterSet' | 'spellTrapSet' | 'attackDeclared' | 'judged' | 'moved' | 'deckShuffled' | 'appealed' }
    >
  | { type: 'monsterSet' | 'spellTrapSet'; player: Seat; card: string | null; zone: number }
  | (Omit<Extract<DuelEvent, { type: 'moved' }>, 'card'> & { card: string | null })
  /** A judge decision. `card` is null when the player can't see it. Contest it by its log entry's `seq`. */
  | { type: 'judged'; stage: 'activation' | 'resolution'; player: Seat; card: string | null; legal: boolean; summary: string; failed: boolean }
  | { type: 'appealed'; judged: number; by: Seat; verdict: 'upheld' | 'overturned'; explanation: string }
  /** `targetZone` locates a face-down target, which the attacker's view shows without an ID until it flips. */
  | (Extract<DuelEvent, { type: 'attackDeclared' }> & { targetZone: number | null });

/** One entry of a player's duel log. Every visible event gets one; `text` is null for events the log doesn't spell out. */
export interface LogEntry {
  /** Position of the event in the duel's event list. */
  seq: number;
  turn: number;
  event: LogEvent;
  text: string | null;
}

/**
 * What the server pushes to a player. `sync` is the whole picture, sent on connect. `steps` follows each change,
 * with the board after every event so the client can animate them one by one.
 */
export type DuelUpdate =
  | { type: 'sync'; view: PlayerView; log: LogEntry[]; judging: JudgingView | null }
  | { type: 'steps'; steps: { entry: LogEntry; view: PlayerView }[] }
  /** The judge started, asked a player something, got an answer, or finished (null). */
  | { type: 'judging'; judging: JudgingView | null };

/** The judge at work on an effect. Nothing it does reaches the board until it finishes. */
export interface JudgingView {
  stage: 'activation' | 'resolution';
  player: Seat;
  /** Hidden while the opponent is still checking whether a card from their hand can be activated. */
  card: CardView;
  /** Who the judge is waiting on, or null while the model works. */
  waitingOn: Seat | null;
  /** The question, for the player it is put to; null for the other player. */
  prompt: PromptView | null;
}

/** An `ask_player` question. Answer with POST /api/duels/:id/answer `{ prompt, picks }`, picking card IDs or choices. */
export interface PromptView {
  id: string;
  text: string;
  /**
   * Cards to pick from, answered by `pick`: the card's ID, or for a face-down card on the field (which the asked
   * player may not identify) a key for this question only. `zone` is the zone index of a card on the field.
   */
  cards: { pick: string; card: CardView; place: Place; seat: Seat; zone: number | null }[];
  /** Picks that aren't cards, such as "Gain 1200 LP". */
  choices: string[];
  min: number;
  max: number;
}

/** Where a card is, without the slot. */
export type Place = 'deck' | 'hand' | 'monsters' | 'spellTraps' | 'graveyard' | 'banished' | 'extra';

export type CardView = { id: string; card: CardData } | { hidden: true };

export interface FieldCardView {
  card: CardView;
  position: Position;
  faceUp: boolean;
  /** A face-up monster's current ATK, DEF and Level, after modifiers. */
  stats: { atk: number; def: number; level: number | null } | null;
}

export interface PlayerSideView {
  name: string;
  lp: number;
  deckCount: number;
  hand: CardView[];
  monsters: (FieldCardView | null)[];
  spellTraps: (FieldCardView | null)[];
  graveyard: CardView[];
  banished: CardView[];
  extra: CardView[];
}

/** What the player may do now; the client turns one into an Intent, filling in the choices. */
export type LegalAction =
  /** `zones` are the Monster Zones it may go to: the empty ones, plus those of possible tributes. */
  | { type: 'normalSummon'; card: string; tributes: number; tributeFrom: string[]; zones: number[] }
  | { type: 'setMonster'; card: string; tributes: number; tributeFrom: string[]; zones: number[] }
  | { type: 'setSpellTrap'; card: string; zones: number[] }
  | { type: 'flipSummon'; card: string }
  | { type: 'changePosition'; card: string }
  | { type: 'enterBattle' }
  | { type: 'attack'; attacker: string; targets: number[]; direct: boolean }
  | { type: 'enterMain2' }
  | { type: 'endTurn'; discard: number }
  /**
   * Activating effect `effect` of the card (an index into its sheet). Only the generic rules are checked here; the judge
   * decides the rest when the player tries. `zones` are the Spell & Trap Zones a card from the hand may go to (null if
   * it isn't in the hand). `text` is the effect's wording, for the menu.
   */
  | { type: 'activate'; card: string; effect: number; zones: number[] | null; text: string }
  | { type: 'surrender' };
