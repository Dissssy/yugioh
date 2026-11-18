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
  race: string;
}

export type Phase = 'draw' | 'standby' | 'main1' | 'battle' | 'main2' | 'end';
export type Position = 'attack' | 'defense';

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
  players: [PlayerState, PlayerState];
  turn: number;
  turnPlayer: Seat;
  phase: Phase;
  normalSummonUsed: boolean;
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
  | { type: 'normalSummon'; card: string; tributes: string[] }
  | { type: 'setMonster'; card: string; tributes: string[] }
  | { type: 'setSpellTrap'; card: string }
  | { type: 'flipSummon'; card: string }
  | { type: 'changePosition'; card: string }
  | { type: 'enterBattle' }
  | { type: 'attack'; attacker: string; target: number | 'direct' }
  | { type: 'enterMain2' }
  | { type: 'endTurn'; discard: string[] }
  | { type: 'surrender' };

/** Everything that happens is one of these. The duel's state is the fold of its events. */
export type DuelEvent =
  | {
      type: 'duelStarted';
      cards: Record<number, CardData>;
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
  | { type: 'duelEnded'; result: DuelResult };

export interface StartingPlayer {
  name: string;
  deck: string[];
  extra: string[];
}

/** The duel as one player sees it. Hidden cards carry no ID and no card data. */
export interface PlayerView {
  you: Seat;
  turn: number;
  turnPlayer: Seat;
  phase: Phase;
  normalSummonUsed: boolean;
  result: DuelResult | null;
  players: [PlayerSideView, PlayerSideView];
  actions: LegalAction[];
  log: string[];
}

export type CardView = { id: string; card: CardData } | { hidden: true };

export interface FieldCardView {
  card: CardView;
  position: Position;
  faceUp: boolean;
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
  | { type: 'normalSummon'; card: string; tributes: number; tributeFrom: string[] }
  | { type: 'setMonster'; card: string; tributes: number; tributeFrom: string[] }
  | { type: 'setSpellTrap'; card: string }
  | { type: 'flipSummon'; card: string }
  | { type: 'changePosition'; card: string }
  | { type: 'enterBattle' }
  | { type: 'attack'; attacker: string; targets: number[]; direct: boolean }
  | { type: 'enterMain2' }
  | { type: 'endTurn'; discard: number }
  | { type: 'surrender' };
