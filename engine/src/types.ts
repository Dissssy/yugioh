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
  /**
   * The event it needs, as data code checks: for a trigger, what makes it fire ("When this card is Normal Summoned");
   * for any other effect, the event it must be activated in response to ("When an opponent's monster declares an
   * attack"). Null when it needs no event.
   */
  when: When | null;
  /** The effect as data that code runs exactly, with no judge, or null when the judge applies it (see docs/effects.md). */
  script: Script | null;
  /** For a `continuous` effect: what it does as data, applied by code while the card is face-up on the field; else null. */
  continuous: Continuous | null;
  /**
   * `unverified` as compiled; `verified` once a person checked it (the compiler then never overwrites the sheet);
   * `flagged` after a player reported the card or an appeal overturned its script, so its script is set aside and the
   * judge rules on it until someone fixes or restores it.
   */
  status: 'unverified' | 'verified' | 'flagged';
}

/**
 * How a monster was Summoned. A Tribute Summon is a Normal Summon. Synchro and Xyz Summons are Special Summons too, so
 * `special` in a `when` or a condition also matches them (see `summonMatches`).
 */
export type SummonKind = 'normal' | 'flip' | 'special' | 'synchro' | 'xyz';

/**
 * How an Extra Deck monster is Summoned, as data code checks. Synchro: exactly one face-up Tuner (`tuner` names the one
 * it needs, or null for any) and `nonTuners` face-up non-Tuner monsters, whose current Levels add up to this card's
 * Level; they go to the GY. Xyz: `count` face-up monsters of current Level `level`, attached to it as materials.
 */
export type Materials =
  | { summon: 'synchro'; tuner: string | null; nonTuners: { min: number; max: number | null } }
  | { summon: 'xyz'; level: number; count: number };

/** The event an effect waits for (see `SheetEffect.when`). */
export interface When {
  /**
   * `summoned`: a monster is Summoned. `attack_declared`: a monster declares an attack (the event's card is the
   * attacker). `attacked`: a monster is targeted for an attack (the event's card is the target). `destroyed_by_battle`: a monster is destroyed by battle. `battle_damage`: a monster inflicts battle
   * damage to its controller's opponent. `battle_destroying`: a monster destroys another by battle (the event's card is the one that destroyed it: "When this card destroys a monster by battle"). `activated`: a card or effect is activated (Counter Traps).
   * `destroyed_by_effect`: a card on the field is destroyed by a card effect; the filter is checked against the card as
   * it was on the field, for its side and whether it was face-up. `damage_step_start`: the start of the Damage Step (the
   * event's card is the attacker). `end_phase`: the End Phase starts.
   */
  event:
    | 'summoned'
    | 'attack_declared'
    | 'attacked'
    | 'destroyed_by_battle'
    | 'destroyed_by_effect'
    | 'battle_destroying'
    | 'battle_damage'
    | 'activated'
    | 'damage_step_start'
    | 'end_phase';
  /** Only when it happens to this card itself ("When this card is Normal Summoned"). */
  self: boolean;
  /** The card it happens to must fit this as it is after the event ("this face-up Attack Position card"); null for any card. */
  filter: CardFilter | null;
  /** For `summoned`, which Summons count; empty for any. */
  how: SummonKind[];
  /** For a trigger: where this card must be when the event happens (Ganbara Knight waits in the hand). */
  from: 'field' | 'hand' | 'graveyard';
  /**
   * An optional "When ...: You can" trigger misses the timing unless its event was the last thing to happen (it
   * happened during the last chain link to resolve). "If ..." triggers and mandatory ones never miss.
   */
  canMiss: boolean;
  /** For `destroyed_by_effect`: whose card effect it must be ("by your opponent's card effect"); null for anyone's. */
  by: 'you' | 'opponent' | null;
}

/**
 * A structured effect. Code checks its activation exactly (conditions, cost, targets, and that the effect can do what
 * it must), so an activation it refuses is never offered, and resolves it as fixed steps.
 */
export interface Script {
  /** Board conditions the activation needs, beyond what its cost, targets and steps need. */
  conditions: Condition[];
  /** Paid on activation, in order. */
  cost: Step[];
  /**
   * Chosen by the activating player on activation, after the cost; null if the effect doesn't target. `event`: only
   * the card the effect's `when` event happened to may be targeted ("Target that monster").
   */
  targets: { filter: CardFilter; min: number; max: number; event: boolean } | null;
  /** What the effect does. One option, or several when the text says "activate 1 of these effects" (picked on activation by `label`). */
  options: { label: string; steps: Step[] }[];
  /** Any part of the text the steps can't express yet (a lingering restriction), said in the summary; else null. */
  unapplied: string | null;
}

export type Condition =
  /** At least `min` and at most `max` (null: no bound) cards fit `filter`. */
  | { if: 'count'; filter: CardFilter; min: number; max: number | null }
  /** It is this player's turn ("during your Battle Phase" is this and a `phase`). */
  | { if: 'turn'; whose: 'you' | 'opponent' }
  /** This card is face-up in this battle position ("while in face-up Defense Position"). */
  | { if: 'position'; position: Position }
  /** The activating player hasn't conducted their Battle Phase this turn. */
  | { if: 'before_battle_phase' }
  /** It is one of these phases. For an ignition effect this replaces the Main Phase it otherwise needs (Speed Warrior). */
  | { if: 'phase'; phases: Phase[] }
  /** This card was Summoned this turn, in one of these ways (empty for any). */
  | { if: 'summoned_this_turn'; how: SummonKind[] }
  /** This card has between `min` and `max` Xyz Materials (null: no bound); "while it has no material" is max 0. */
  | { if: 'materials'; min: number | null; max: number | null };

/** One thing an effect does, to the cards `cards` selects. "You" is the activating player. */
/** Kinds of counters. The starter decks only use Spell Counters. */
export type Counter = 'spell';

export type Step =
  | { do: 'destroy'; cards: Selection }
  | { do: 'move'; cards: Selection; to: Destination }
  /** `choice`: the activating player picks Attack or Defense Position. */
  | { do: 'special_summon'; cards: Selection; position: Position | 'choice' }
  | { do: 'modify_stats'; cards: Selection; atk: number; def: number; levelDelta: number; levelSet: number | null; until: Until }
  /** ATK and/or DEF "become" a value (null leaves that stat alone). Gains and losses still apply on top. */
  | { do: 'set_stats'; cards: Selection; atk: StatValue | null; def: StatValue | null; until: Until }
  | { do: 'change_lp'; player: 'you' | 'opponent'; amount: number; kind: 'cost' | 'damage' | 'gain' }
  | { do: 'draw'; player: 'you' | 'opponent'; count: number }
  | { do: 'extra_normal_summon' }
  /** Negates the attack being made: it ends without damage. */
  | { do: 'negate_attack' }
  /** Detaches `count` Xyz Materials from an Xyz Monster the selection picks (only those with that many can be picked). */
  | { do: 'detach'; cards: Selection; count: number }
  /**
   * Links the card being resolved to the monster on the field the selection picks: equips an Equip Spell, or ties a
   * Continuous Trap to its target. It is destroyed when that monster leaves the field.
   */
  | { do: 'link'; cards: Selection }
  /** Negates the activation this effect answers ("negate the activation"); `destroy`: "and if you do, destroy it". */
  | { do: 'negate_activation'; destroy: boolean }
  /** The monsters the selection picks have their effects negated while they stay face-up on the field. */
  | { do: 'negate_effects'; cards: Selection }
  /** This card is Set face-down again instead of going to the GY when it resolves (Scrap-Iron Scarecrow). */
  | { do: 'set_again' }
  /** Places counters on each card selected, up to `max` on a card (null: no limit). */
  | { do: 'add_counters'; cards: Selection; counter: Counter; count: number; max: number | null }
  /** Removes counters from the card selected (a cost: "remove 1 Spell Counter from this card"). */
  | { do: 'remove_counters'; cards: Selection; counter: Counter; count: number }
  /** For the rest of this turn, that player can't declare attacks, or can't conduct their Battle Phase. */
  | { do: 'forbid'; player: 'you' | 'opponent'; what: Forbidden };

export const FORBIDDEN = ['declare_attack', 'battle_phase'] as const;
/** What a lingering restriction from a resolved effect stops a player doing this turn (Threatening Roar, Reinforce Truth). */
export type Forbidden = (typeof FORBIDDEN)[number];

/**
 * A continuous effect: it applies, with no activation, while its card is face-up on the field and every `while`
 * condition holds ("you" is the card's controller). Code derives it on each read (see continuous.ts), so nothing is
 * stored and nothing can go stale.
 * - `stats`: the cards in `to` gain `atk`/`def` (times the count of `per`: the cards that fit it, or this card's Xyz
 *   Materials), and their Level changes by `levelDelta` or becomes `levelSet`.
 * - `restrict`: the cards in `to` (not this card itself when `others`) can't do these things. For
 *   `be_destroyed_by_battle`, `by` is the monster they battle ("with a monster that has 1900 or more ATK"); null for any.
 * - `self_destruct`: this card remains on the field after it resolves, and is destroyed in the End Phase of its
 *   controller's opponent's `opponentTurns`th turn after its activation (Swords of Revealing Light).
 * - `tie`: more about this card's tie to its linked monster (every linked card is destroyed when its monster leaves the
 *   field). `destroyLinked`: when this card leaves the field, the monster is destroyed (Birthright). `defenseBreaks`: if
 *   the monster is changed to Defense Position, both are destroyed (Limit Reverse).
 */
export type Continuous =
  | { apply: 'stats'; to: Affected; atk: number; def: number; per: CardFilter | 'materials' | null; levelDelta: number; levelSet: number | null; while: Condition[] }
  | { apply: 'restrict'; to: Affected; others: boolean; cannot: Restriction[]; by: CardFilter | null; while: Condition[] }
  | { apply: 'self_destruct'; opponentTurns: number }
  | { apply: 'tie'; destroyLinked: boolean; defenseBreaks: boolean }
  /**
   * "If this face-up card would be destroyed, you can detach `detach` Xyz Material(s) from it instead": its controller
   * is asked each time, in battle and against effects, while it has enough.
   */
  | { apply: 'replace_destruction'; detach: number };

export const RESTRICTIONS = ['attack', 'change_position', 'be_attacked', 'be_destroyed_by_battle'] as const;
/** What a restricted monster can't do: declare an attack, change its battle position, be targeted for an attack, or be destroyed by battle. */
export type Restriction = (typeof RESTRICTIONS)[number];

/**
 * The cards a continuous effect applies to: this card, the monster it is linked to (the equipped monster, or the one
 * a Continuous Trap targeted), or face-up monsters that fit a filter.
 */
export type Affected = 'self' | 'linked' | CardFilter;

/**
 * A stat read from a card when the step resolves: `self` or the first target still there. `original` is the printed
 * value, else the current one. `times` multiplies it ("double its original ATK" is 2).
 */
export interface StatValue {
  of: 'self' | 'targets';
  stat: 'atk' | 'def';
  original: boolean;
  times: number;
}

/**
 * Which cards a step affects. `choose` asks the activating player for `min` to `max` cards that fit (from those tied
 * for the lowest or highest stat, if `rank` is set). `all` takes every card that fits. The card being activated is
 * never chosen, targeted or counted, except as `self`.
 */
export type Selection =
  | { from: 'self' }
  | { from: 'targets' }
  | { from: 'choose'; filter: CardFilter; min: number; max: number; rank: { stat: 'atk' | 'def' | 'level'; order: 'lowest' | 'highest' } | null }
  | { from: 'all'; filter: CardFilter }
  /** The monster battling this card, if it fits ("At the start of the Damage Step, if this card attacks a face-up Defense Position monster: destroy that monster"). */
  | { from: 'battling'; filter: CardFilter };

/** Cards that fit a description such as "1 face-up Warrior monster your opponent controls". Empty lists and nulls don't restrict. */
export interface CardFilter {
  /** Whose: the controller of a card on the field, or the player whose hand, Deck, GY or banished pile it is in. */
  side: 'you' | 'opponent' | 'either';
  /** `any`: wherever it is (a monster effect activated from the hand or GY still is one). */
  place: 'field' | 'monsters' | 'spellTraps' | 'hand' | 'deck' | 'graveyard' | 'banished' | 'any';
  kinds: ('monster' | 'spell' | 'trap')[];
  /** Words that must all be in the card's type line, such as "Synchro", "Tuner", "Normal" ("non-Effect"), "Effect". */
  types: string[];
  /** Any of these monster types ("Warrior") or Spell/Trap properties ("Quick-Play"). */
  races: string[];
  attributes: string[];
  faceUp: boolean | null;
  position: Position | null;
  /** Current values for a face-up monster, printed ones elsewhere. A card without the stat never fits a range on it. */
  level: Range | null;
  atk: Range | null;
  def: Range | null;
}

export interface Range {
  min: number | null;
  max: number | null;
}

export interface EffectSheet {
  code: number;
  /** sha256 of the card text the sheet was made from; a sheet whose hash no longer matches is ignored. */
  textHash: string;
  /** Who wrote it: the compiling model, or "admin" for a hand edit. */
  model: string;
  effects: SheetEffect[];
  /** How an Extra Deck monster is Summoned, or null for any other card. */
  materials: Materials | null;
}

export const HANDS = ['rock', 'paper', 'scissors'] as const;
/** A rock-paper-scissors pick. */
export type Hand = (typeof HANDS)[number];

export type Phase = 'draw' | 'standby' | 'main1' | 'battle' | 'main2' | 'end';
export type Position = 'attack' | 'defense';

/** A change to a face-up monster's stats. Every modifier ends when the card leaves the field. */
export interface Modifier {
  card: string;
  /** Who applied it, for "your next Standby Phase". */
  player: Seat;
  atk: number;
  def: number;
  /** ATK and DEF "become" these (the latest set wins), before every gain and loss is added. */
  atkSet: number | null;
  defSet: number | null;
  /** Added to the Level. */
  levelDelta: number;
  /** The Level becomes this, before levelDelta of later modifiers. */
  levelSet: number | null;
  until: Until;
  turn: number;
}

export const UNTIL = ['end_of_turn', 'end_of_battle_phase', 'next_standby_phase', 'while_on_field'] as const;
export type Until = (typeof UNTIL)[number];

/** An activated effect waiting to resolve. */
export interface ChainLink {
  player: Seat;
  card: string;
  effect: number;
  targets: string[];
  /** The effect chosen on activation when the text offers several ("Activate 1 of these effects"), as the judge worded it. */
  choice: string | null;
  /** The event it was activated for: what set off a trigger, or what a response responds to; else null. */
  cause: Happening | null;
  /** An effect negated its activation: it resolves doing nothing, and its card goes to the GY. */
  negated: boolean;
  /** Its card is Set again instead of going to the GY when it resolves (`set_again`). */
  setAgain: boolean;
}

/**
 * Something that happened that triggers and responses watch for. `player` controlled `card` when it happened (for a
 * phase, the turn player). `group` counts resolved chain links, so code can tell what happened last.
 */
export type Happening =
  | { event: 'summoned'; card: string; player: Seat; how: SummonKind; group: number }
  | { event: 'attack_declared'; card: string; player: Seat; target: string | null; group: number }
  | { event: 'attacked'; card: string; player: Seat; attacker: string; group: number }
  | { event: 'destroyed_by_battle'; card: string; player: Seat; group: number }
  | { event: 'battle_destroying'; card: string; player: Seat; target: string; group: number }
  | { event: 'battle_damage'; card: string; player: Seat; amount: number; group: number }
  /** A card or effect was activated: chain link `link` (from 0). Only responses watch for it, never triggers. */
  | { event: 'activated'; card: string; player: Seat; link: number; group: number }
  /** `by`: the player whose card effect destroyed it; `player`: who controlled it; `faceUp`: whether it was face-up. */
  | { event: 'destroyed_by_effect'; card: string; player: Seat; by: Seat; faceUp: boolean; group: number }
  /** The Damage Step of `card`'s attack starts; `target` is the monster it attacks, null for a direct attack. */
  | { event: 'damage_step_start'; card: string; player: Seat; target: string | null; group: number }
  | { event: 'phase'; phase: 'battle' | 'end'; player: Seat; group: number };

/** What happens once a sequence of triggers, responses and chains is over. */
/** `damage_step`: the attack's Damage Step starts; `damage`: its damage calculation. */
export type Then = { do: 'open' } | { do: 'damage_step' } | { do: 'damage' } | { do: 'endTurn'; discard: string[] };

/**
 * Where the duel is: deciding who goes first, or in the timing of effects (docs/chains.md).
 * - `rps`: before the first turn, both players pick rock, paper or scissors. `picks` stay hidden from the opponent;
 *   `last` is the tied round before, if any.
 * - `order`: `chooser` won rock-paper-scissors and picks whether to go first or second.
 * - `open`: the turn player acts.
 * - `triggers`: triggers from what just happened go on the chain, turn player's first (mandatory before optional).
 *   `handled` holds `card:effect` keys already activated or set aside, `passed` the players who declined the rest.
 * - `respond`: a response window. `priority` may activate a fast effect or pass; two passes in a row close it.
 *   `actor` is the player whose action gave `priority` the window. `cause` is the event the chain answers.
 * - `resolve`: the chain resolves, last link first.
 * - `continue`: the sequence is over; `then` happens next (the attack's damage, or the end of the turn).
 */
export type DuelStep =
  | { at: 'rps'; picks: [Hand | null, Hand | null]; last: [Hand, Hand] | null }
  | { at: 'order'; chooser: Seat; hands: [Hand, Hand] }
  | { at: 'open' }
  | { at: 'triggers'; cause: Happening | null; then: Then; handled: string[]; passed: Seat[] }
  | { at: 'respond'; cause: Happening | null; then: Then; priority: Seat; actor: Seat; passed: boolean }
  | { at: 'resolve'; then: Then }
  | { at: 'continue'; then: Then }
  /** `card` would be destroyed by battle; `player`, its controller, decides whether to detach materials instead. */
  | { at: 'replace'; card: string; player: Seat; then: Then };

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
  /** How and on which turn it was last Summoned; null if it was Set and not flipped since. */
  summoned: { how: SummonKind; turn: number } | null;
  /** Xyz Materials attached to it, first attached first. They go to the GY when it leaves the field. */
  materials: string[];
  /** For a Spell/Trap, the turn its card was activated; null while Set. */
  activatedTurn: number | null;
  /** For a Spell/Trap, the monster it is equipped or tied to (see the `link` step); else null. */
  linked: string | null;
  /** Its effects are negated while it stays face-up on the field ("but it has its effects negated"). */
  effectsNegated: boolean;
  /** Counters on it, by kind. */
  counters: Partial<Record<Counter, number>>;
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
  /** What resolved effects stopped each player doing this turn; they lapse when the turn ends. */
  forbidden: { player: Seat; what: Forbidden; turn: number }[];
  chain: ChainLink[];
  step: DuelStep;
  /** Events since the last triggers were put on the chain, for triggers to watch. */
  happened: Happening[];
  /** Chain links resolved so far in the duel, the `group` of new happenings. */
  resolvedLinks: number;
  /** The attack being made, from its declaration until damage is done. */
  /** `replaced`: for each monster that would be destroyed in this battle, the materials detached instead (empty: none). */
  attack: { attacker: string; target: string | null; replaced: Record<string, string[]> } | null;
  /** Effects used this turn, for once-per-turn clauses. */
  usedThisTurn: { card: string; code: number; effect: number }[];
  /**
   * Rulings on activations that stand for the board as it is now, until any event changes it (another illegal ruling
   * or an appeal changes nothing). An activation the judge ruled illegal is refused without asking it again
   * (`legal` false, the judge's summary); once an appeal overturns that, the next try must be ruled legal (`legal`
   * true, the appeal's ruling, which the judge is given).
   */
  rulings: { player: Seat; card: string; effect: number; legal: boolean; summary: string }[];
  /** An overturned ruling's offer to rewind the duel to just before it; both players must accept. */
  rollback: RollbackOffer | null;
  /** After a rollback to before a resolution, the appeal's ruling the judge must follow when that link resolves again. */
  binding: { player: Seat; card: string; effect: number; ruling: string } | null;
  result: DuelResult | null;
}

/** The board as it was at an earlier event, without what never changes (the cards) or must stay current (the sheets). */
export type Board = Omit<DuelState, 'instances' | 'cards' | 'sheets'>;

export interface RollbackOffer {
  /** The event index of the overturned `judged` event, and of the first event the rollback undoes. */
  judged: number;
  to: number;
  decision: AppealRecord['decision'];
  /** The appeal's ruling (for the judge) and its explanation (for the players). */
  ruling: string;
  explanation: string;
  accepted: Seat[];
}

export interface DuelResult {
  winner: Seat | null;
  reason: 'lp' | 'deckOut' | 'surrender';
}

/**
 * Each player's `monsters` holds the five Main Monster Zones (0 to 4), then the two Extra Monster Zones: 5 on the
 * player's left and 6 on their right. The Extra Monster Zones are shared, so a player's 5 is the opponent's 6 (see
 * `acrossTable`): a card sits in the array of the player who controls it, and the same zone in the other player's
 * array is then empty.
 */
export const MONSTER_ZONES = 5;
export const EXTRA_MONSTER_ZONES = [5, 6] as const;
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
  /** Synchro or Xyz Summons `card` from the Extra Deck with these materials, into `zone`. */
  | { type: 'extraSummon'; card: string; materials: string[]; zone: number; position: Position }
  /** Activates effect `effect` (an index into the card's effect sheet). `zone` is where a Spell/Trap from the hand goes. */
  | { type: 'activate'; card: string; effect: number; zone: number | null }
  /** Declines to respond, or to activate optional triggers. */
  | { type: 'pass' }
  /** Accepts or declines rewinding to before an overturned ruling. */
  | { type: 'rollback'; accept: boolean }
  /** Answers a `replace` step: the materials to detach instead of the destruction, or none to let it be destroyed. */
  | { type: 'replace'; materials: string[] }
  | { type: 'rps'; hand: Hand }
  /** The rock-paper-scissors winner goes first, or lets the opponent go first. */
  | { type: 'chooseOrder'; goFirst: boolean }
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
  | { op: 'modify_stats'; card: string; atk: number; def: number; atk_set: number | null; def_set: number | null; level_delta: number; level_set: number | null; until: Until }
  | { op: 'change_position'; card: string; position: Position }
  | { op: 'draw'; player: Seat; count: number }
  | { op: 'extra_normal_summon'; player: Seat }
  | { op: 'negate_attack' }
  /** Detaches this Xyz Material: it goes to its owner's GY. */
  | { op: 'detach'; card: string }
  | { op: 'forbid'; player: Seat; what: Forbidden }
  /** Links the card being resolved to this face-up monster (see the `link` step). */
  | { op: 'link'; card: string }
  /** Negates the activation of this card's link on the chain, below the one resolving. */
  | { op: 'negate_activation'; card: string }
  | { op: 'negate_effects'; card: string }
  /** Sets the card being resolved face-down again instead of sending it to the GY. */
  | { op: 'set_again' }
  | { op: 'add_counters'; card: string; counter: Counter; count: number; max: number | null }
  | { op: 'remove_counters'; card: string; counter: Counter; count: number }
  | { op: 'declare_targets'; cards: string[] }
  | { op: 'choose_effect'; choice: string };

/** The tokens one Messages API call used, as the API reported them; the server prices them. */
export interface ModelUsage {
  model: string;
  /** Uncached input tokens. */
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
}

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
  /** Every API call the judge made for this decision. */
  usage: ModelUsage[];
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
  /** Every API call the appeal made. */
  usage: ModelUsage[];
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
    }
  /** A player's rock-paper-scissors pick. Only that player sees it until both have picked. */
  | { type: 'rpsPicked'; player: Seat; hand: Hand }
  /** Both picks, shown together. `winner` chooses who goes first; on a tie (null) both pick again. */
  | { type: 'rpsShown'; hands: [Hand, Hand]; winner: Seat | null }
  /** The winner of rock-paper-scissors chose who goes first. */
  | { type: 'orderChosen'; player: Seat; first: Seat }
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
  /** `by` is the monster that inflicted it. */
  | { type: 'battleDamage'; player: Seat; amount: number; by: string }
  /** The attack is over. `replay`: its target left, so the attacker may attack again. */
  | { type: 'attackEnded'; replay: boolean }
  | { type: 'destroyedByBattle'; cards: string[] }
  | { type: 'discarded'; player: Seat; cards: string[] }
  | { type: 'judged'; record: JudgeRecord }
  /** A Spell/Trap from the hand goes face-up to `zone`; a Set one flips face-up; a monster's effect leaves it where it is. */
  | { type: 'effectActivated'; player: Seat; card: string; effect: number; zone: number | null; cause: Happening | null }
  /** Triggers from what just happened go on the chain next, then a response window if needed, then `then`. */
  | { type: 'checkpoint'; cause: Happening | null; then: Then }
  /** Every trigger is on the chain or set aside. */
  | { type: 'triggersDone' }
  /** The player declined to respond, or to activate their optional triggers. */
  | { type: 'passed'; player: Seat }
  | { type: 'targeted'; cards: string[] }
  | { type: 'effectChosen'; choice: string }
  | { type: 'moved'; card: string; owner: Seat; from: Place; to: Destination }
  | { type: 'deckShuffled'; player: Seat; order: string[] }
  | { type: 'specialSummoned'; player: Seat; card: string; zone: number; position: Position }
  /** A Synchro or Xyz Summon from the Extra Deck. Synchro materials go to the GY; Xyz materials are attached to it. */
  | { type: 'extraSummoned'; player: Seat; card: string; how: 'synchro' | 'xyz'; materials: string[]; zone: number; position: Position }
  /** `by`: the player whose card effect destroyed them. */
  | { type: 'destroyed'; cards: string[]; by: Seat }
  | { type: 'lpChanged'; player: Seat; amount: number; kind: 'damage' | 'cost' | 'gain' }
  | { type: 'statsModified'; modifier: Modifier }
  | { type: 'forbidden'; player: Seat; what: Forbidden }
  | { type: 'linked'; card: string; to: string }
  | { type: 'activationNegated'; link: number; card: string }
  | { type: 'effectsNegated'; card: string }
  | { type: 'setAgain' }
  | { type: 'countersChanged'; card: string; counter: Counter; delta: number }
  /** The attack moves into its Damage Step. */
  | { type: 'damageStepStarted' }
  | { type: 'replacementOffered'; card: string; player: Seat; then: Then }
  | { type: 'replacementChosen'; card: string; materials: string[] }
  | { type: 'normalSummonGranted'; player: Seat }
  /** The chain link resolved: it leaves the chain, and a Normal or Quick-Play Spell or Normal Trap goes to the GY. */
  | { type: 'linkResolved' }
  | { type: 'appealed'; appeal: AppealRecord }
  /** After an overturned ruling that changed the board: both players may rewind to before it. */
  | { type: 'rollbackOffered'; offer: Omit<RollbackOffer, 'accepted'> }
  | { type: 'rollbackAnswered'; player: Seat; accept: boolean }
  /** Both accepted: the board goes back to `board` (the state before event `to`), and the corrected ruling applies. */
  | { type: 'rolledBack'; to: number; board: Board }
  /** A card's sheet changed while the duel was going (a report flagged it, or it was fixed); null if it no longer has one. */
  | { type: 'sheetUpdated'; code: number; sheet: EffectSheet | null }
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
  /**
   * Who the duel waits on while triggers go on the chain or a response window is open, or null. `cause` says what the
   * window answers ("Axe Raider's attack"). The other player sees the same, whether or not the player can respond.
   */
  /** For `replace`, `cause` names the monster that would be destroyed. */
  waiting: { player: Seat; for: 'respond' | 'triggers' | 'replace'; cause: string | null } | null;
  /** Deciding who goes first, before turn 1; null once the duel is under way. */
  start: StartView | null;
  /** An offer to rewind to before an overturned ruling: what the appeal said, how many log entries it undoes, who accepted. */
  rollback: { explanation: string; accepted: Seat[] } | null;
  actions: LegalAction[];
}

/**
 * Rock-paper-scissors as one player sees it: their own pick, whether the opponent has picked (never what), and the
 * tied round before. Then the winner's choice of who goes first. Hands are indexed by seat.
 */
export type StartView =
  | { at: 'rps'; yours: Hand | null; theirsIn: boolean; last: [Hand, Hand] | null }
  | { at: 'order'; chooser: Seat; hands: [Hand, Hand] };

/**
 * An event as one player may see it: a card Set by the opponent has no ID, nor does a card moving between places
 * the player can't see. Intents, the duel's start, Deck orders and rock-paper-scissors picks (until both are shown) are never shown, and a judge decision shows only its outcome.
 */
export type LogEvent =
  | Exclude<
      DuelEvent,
      {
        type:
          | 'duelStarted'
          | 'intent'
          | 'rpsPicked'
          | 'monsterSet'
          | 'spellTrapSet'
          | 'attackDeclared'
          | 'judged'
          | 'moved'
          | 'deckShuffled'
          | 'appealed'
          | 'sheetUpdated'
          | 'checkpoint'
          | 'triggersDone'
          | 'passed'
          | 'attackEnded'
      }
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
  /** `entry` is null for a step nobody sees in the log that still changes the board (a pass). */
  | { type: 'steps'; steps: { entry: LogEntry | null; view: PlayerView }[] }
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
/** `materials`: attached to an Xyz Monster as Xyz Material. */
export type Place = 'deck' | 'hand' | 'monsters' | 'spellTraps' | 'materials' | 'graveyard' | 'banished' | 'extra';

export type CardView = { id: string; card: CardData } | { hidden: true };

export interface FieldCardView {
  card: CardView;
  position: Position;
  faceUp: boolean;
  /** A face-up monster's current ATK, DEF and Level, after modifiers. */
  stats: { atk: number; def: number; level: number | null } | null;
  /** Its Xyz Materials, which both players can see. */
  materials: CardView[];
  /** Spell Counters on it. */
  spellCounters: number;
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
  /** Summoning `card` from the Extra Deck: each option is a set of materials and the zones it may then go to. */
  | { type: 'extraSummon'; card: string; how: 'synchro' | 'xyz'; options: { materials: string[]; zones: number[] }[] }
  /**
   * Activating effect `effect` of the card (an index into its sheet). Only the generic rules are checked here; the judge
   * decides the rest when the player tries. `zones` are the Spell & Trap Zones a card from the hand may go to (null if
   * it isn't in the hand). `text` is the effect's wording, for the menu.
   */
  | { type: 'activate'; card: string; effect: number; zones: number[] | null; text: string }
  /** Pass in a response window, or decline your optional triggers. */
  | { type: 'pass' }
  /** Answer the rollback offer. */
  | { type: 'rollback' }
  /** Detach `count` of `materials` from `card` instead of its destruction, or not. */
  | { type: 'replace'; card: string; materials: string[]; count: number }
  | { type: 'rps' }
  | { type: 'chooseOrder' }
  | { type: 'surrender' };
