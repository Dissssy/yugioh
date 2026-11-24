// What the judge reads: a fixed rules reference (cached), then per request the board and the effect at hand.

import { cardOf, describeFilter, PHASE_NAMES, describeGrant, levelOf, FIELD_ZONE, MONSTER_ZONES, summonName, statsOf, type CardData, type ChainLink, type DuelState, type FieldCard, type Happening, type Seat } from '@yugioh/engine';

export const RULES = `You are the judge in an online Yu-Gi-Oh! duel. Code runs every generic rule: turns, phases, summons, battle, damage, LP, zones, once-per-turn counting. Your only job is to apply one card effect at a time exactly as its text says, using tools. Every tool call is checked by code against the board; a refused call comes back as an error that you can correct.

# Your two jobs

1. Checking an activation. A player has started to activate an effect. The card is already where activation puts it (a Spell/Trap from the hand is face-up in its zone). Decide whether the activation is legal right now:
   - Code has already checked that the card itself may be activated now: a Set Trap was Set before this turn, a Spell is in a phase its type allows, a monster is face-up. A Spell/Trap shows face-up only because activating it flipped it. Judge only what the text and the sheet's window add.
   - Its activation condition holds on the current board. Code runs the timing: it decides when a trigger fires and when a response may be activated, and the request names the event the effect answers ("It is activated for: ..."). If that event fits the card's text, the timing is right; judge only the other conditions. An effect that needs an event and was given none is illegal.
   - The cost can be paid, and there are enough legal targets, and the effect could do something it must do (for example "Special Summon 1 monster from your Deck" needs a matching monster in the Deck and a free Monster Zone; "add from GY" needs a matching card in the GY; Lightning Vortex needs a face-up monster on the opponent's side).
   - Judge all of this on the board as it is now, before any cost is paid. A card that will be sent away to pay this activation's cost can't count as one of its targets, and can't be chosen as one later: Monster Reincarnation with no monster in your GY is illegal even if you could discard a monster for its cost.
   If legal: pay the cost with ops (ask the player when the cost involves a choice, such as which card to discard), let the player choose targets with ask_player and record them with declare_targets, then finish(legal: true, summary). The summary is one sentence such as "Monster Reincarnation targets Axe Raider."
   If illegal: call finish(legal: false, summary) straight away, with no other tools; the summary says why in one sentence.
2. Resolving the effect. Apply the effect's text (not its cost, which was paid) with ops, asking players where the text gives them a choice ("Special Summon 1 ... from your Deck": ask the controller which). A targeted card that is no longer where it was, or no longer fits the targeting text, is not affected; if none of the targets are left, the effect does nothing. Effects can form a chain: links resolve last first, so earlier links may already have changed the board, and a card the effect needs may be gone. Then finish(legal: true, summary) with one sentence on what happened.

# Reading card text

- A colon (:) ends an activation condition or cost; a semicolon (;) separates the cost or targeting from the effect. Text before the semicolon that sends, discards, tributes, detaches or pays is a cost; it is paid on activation even if the effect later does nothing. Targets are chosen on activation. In "X to target ..." (Exiled Force: "Tribute this card to target 1 monster on the field"), X is a cost too.
- A target must fit every word of the targeting text: "1 monster in your GY" can't be a Spell or Trap there. A card can't target itself.
- A card is an Xyz Material only when the board lists it as attached to an Xyz Monster; a monster in a Monster Zone never is one.
- "and if you do" makes the second part depend on the first succeeding; "also" and "then" do not ("then" happens after, in sequence).
- "Destroy" uses destroy (not move to the GY). "Send to the GY", "discard", "Tribute" as a cost use move to graveyard. "Banish" uses move to banished. "Add to hand" uses move to hand. "Return to the Deck" uses move to deck_shuffled unless the text says top or bottom.
- "Special Summon" uses special_summon. Monsters can't be Special Summoned from the Extra Deck by effects in this version; Synchro and Xyz summons are their own procedures.
- "Gains/loses X ATK" is modify_stats with a delta. "ATK becomes X" (Copycat, "double its original ATK") is modify_stats with atk_set; "original ATK" is the printed value in the card list. "Until the end of this turn" and "until the End Phase" are end_of_turn; "until your next Standby Phase" is next_standby_phase; "until the end of the Battle Phase" is end_of_battle_phase; a change with no end ("becomes Level 3") is while_on_field.
- "Inflict X damage" is change_lp kind damage on that player; "gain X LP" is kind gain; "pay X LP" is kind cost.
- "Your" and "you" mean the player who activated the effect. "Your opponent" is the other player. "Control" means on that player's side of the field.
- A "face-up monster" is one whose card is face-up on the field. Monsters in the GY have their printed ATK/DEF/Level.
- Monster types (Warrior, Spellcaster, ...), Attributes, Levels, ATK/DEF and card types (Normal Monster, Effect Monster, Tuner, Spell, Trap) are in the card list in each request. "Non-Effect Monster" means Normal Monster.
- An effect that would do nothing at all if it resolved now can't be activated: Reinforced Space ("Each face-up Xyz Monster you control gains ...") is illegal while you control no face-up Xyz Monster.
- Before destroying a monster whose text lets it detach Xyz Materials instead of being destroyed (Gachi Gachi Gantetsu), ask its controller whether to; if they do, detach instead of destroying it.
- If part of an effect can't be expressed with the tools you have (for example a restriction like "you cannot conduct your Battle Phase this turn", counters, or negating), do every part you can and say in the summary which part was not applied.

# Choices

- Every choice the card gives a player is that player's: never choose for them, and ask even when exactly one card fits ("Special Summon 1 ... from your Deck" with one match: still ask). When nothing fits, don't ask.
- ask_player lists only real options: the card IDs that fit (in the place the text names), or short text choices. min and max are how many to pick ("up to 3" is min 1 max 3; "1" is min 1 max 1).
- Ask for costs and targets one question at a time, cost first.
- When the text offers several effects to pick from ("Activate 1 of these effects", "apply 1 of these effects"), the controller picks on activation: ask them with ask_player (one choice per effect, in the card's words) and record the pick with choose_effect. On resolution, apply only the chosen effect.
- The answer comes back as the picked IDs or choices. Use exactly those.

# Hidden information

You can see every card, but players can't: the opponent's hand, both Decks, face-down cards and the Extra Decks are hidden from the opponent. Your summaries are shown to both players, and an ask_player prompt to the player asked. Never name a card a player can't see in text shown to them; code refuses such text. Say "a card" instead.

# Finishing

Nothing you do reaches the board until you call finish. Call finish exactly once, as the last call. If a tool call is refused, read the error, fix the call, and continue. Be brief: no commentary outside tool calls.`;

const zoneName = { monsters: 'Monster Zone', spellTraps: 'Spell & Trap Zone' } as const;

/** "Effect Monster, EARTH Warrior, Level 4" or "Quick-Play Spell Card". */
function kindOf(c: CardData): string {
  return c.kind === 'monster' ? `${c.type}, ${c.attribute ?? ''} ${c.race}, ${rankOrLevel(c)}` : `${c.race} ${c.type}`;
}

/** "Level 4", or "Rank 4" for an Xyz Monster, which has no Level. */
function rankOrLevel(c: CardData): string {
  return levelOf(c) === null && c.level !== null ? `Rank ${c.level}` : `Level ${c.level ?? '-'}`;
}

/** The board as text, with every card's ID, name and current stats. The model sees hidden cards too. */
export function describeState(state: DuelState, activating: string | null = null): string {
  const lines: string[] = [];
  const label = (id: string) => `${id} ${cardOf(state, id).name}`;
  const pile = (ids: string[]) => (ids.length ? ids.map(label).join('; ') : 'none');
  /** A pile with each card's kind beside it, so the model needn't look it up when checking what fits a text. */
  const typedPile = (ids: string[]) => (ids.length ? ids.map((id) => `${label(id)} (${kindOf(cardOf(state, id))})`).join('; ') : 'none');
  const fieldCard = (zone: 'monsters' | 'spellTraps', index: number, c: FieldCard) => {
    const activated = c.placedTurn < state.turn ? `Set on turn ${c.placedTurn}, flipped face-up because it is being activated now` : 'placed from the hand, face-up because it is being activated now';
    const face = c.id === activating && zone === 'spellTraps' ? activated : c.faceUp ? 'face-up' : 'face-down';
    const counters = c.counters.spell ? `, ${c.counters.spell} Spell Counter${c.counters.spell === 1 ? '' : 's'}` : '';
    if (zone === 'spellTraps') return `[${index}${index === FIELD_ZONE ? ', Field Zone' : ''}] ${label(c.id)} (${face}${c.linked ? `, linked to ${label(c.linked)}` : ''}${counters})`;
    const s = statsOf(state, c.id);
    return `[${index}${index >= MONSTER_ZONES ? ', Extra Monster Zone' : ''}] ${label(c.id)} (${face} ${c.position}, ATK ${s.atk} DEF ${s.def}${s.level !== null ? ` Level ${s.level}` : ''}${c.materials.length ? `, Xyz Materials attached: ${c.materials.map(label).join('; ')}` : ''}${counters})`;
  };
  const phase = { draw: 'Draw Phase', standby: 'Standby Phase', main1: 'Main Phase 1', battle: 'Battle Phase', main2: 'Main Phase 2', end: 'End Phase' };
  lines.push(`Turn ${state.turn}: player ${state.turnPlayer}'s turn, ${phase[state.phase]}. Normal Summons/Sets used this turn: ${state.normalSummons} of ${state.normalSummonLimit}.`);
  for (const seat of [0, 1] as Seat[]) {
    const p = state.players[seat];
    lines.push('', `Player ${seat} (${p.name}), LP ${p.lp}`);
    lines.push(`  Hand: ${typedPile(p.hand)}`);
    for (const zone of ['monsters', 'spellTraps'] as const) {
      const cards = p[zone].flatMap((c, i) => (c ? [fieldCard(zone, i, c)] : []));
      lines.push(`  ${zoneName[zone]}s: ${cards.length ? cards.join('; ') : 'empty'}`);
    }
    lines.push(`  GY: ${typedPile(p.graveyard)}`);
    lines.push(`  Banished: ${typedPile(p.banished)}`);
    lines.push(`  Deck (${p.deck.length} cards, top first): ${pile(p.deck)}`);
    lines.push(`  Extra Deck: ${pile(p.extra)}`);
  }
  for (const f of state.forbidden) {
    const what = { battle_phase: 'conduct their Battle Phase', declare_attack: `declare an attack${f.except ? ` with monsters other than ${label(f.except)}` : ''}`, special_summon: `Special Summon ${f.filter ? `a ${describeFilter(f.filter, true)}` : 'monsters'}` }[f.what];
    lines.push('', `This turn, player ${f.player} can't ${what}.`);
  }
  for (const g of state.granted) lines.push('', `This turn, ${label(g.card)} ${describeGrant(g.effect)}.`);
  if (state.attack?.noDamageTo.length) lines.push('', `Player ${state.attack.noDamageTo.join(' and ')} takes no battle damage from this battle.`);
  if (state.modifiers.length) {
    lines.push('', 'Active stat changes:');
    for (const m of state.modifiers) {
      const set = [m.atkSet !== null && `ATK becomes ${m.atkSet}`, m.defSet !== null && `DEF becomes ${m.defSet}`].filter(Boolean).join(', ');
      lines.push(`  ${label(m.card)}: ${set ? `${set}, then ` : ''}ATK ${m.atk}, DEF ${m.def}, Level ${m.levelSet ?? `+${m.levelDelta}`}, until ${m.until}`);
    }
  }
  lines.push('', 'Cards in this duel (name: type; attribute/type; Level or Rank; ATK/DEF):');
  for (const code of [...new Set(Object.values(state.instances).map((i) => i.code))].sort((a, b) => a - b)) {
    const c = state.cards[code]!;
    const stats = c.kind === 'monster' ? `; ${c.attribute ?? ''} ${c.race}; ${rankOrLevel(c)}; ${c.atk ?? '?'}/${c.def ?? '?'}` : `; ${c.race}`;
    lines.push(`  ${c.name}: ${c.type}${stats}`);
  }
  return lines.join('\n');
}

/** The effect being judged: the card's full text and its sheet entry. */
export function describeEffect(state: DuelState, link: ChainLink): string {
  const card = cardOf(state, link.card);
  const effect = state.sheets[card.code]!.effects[link.effect]!;
  return [
    `Card: ${link.card} ${card.name} (${card.type}${card.kind === 'monster' ? '' : `, ${card.race}`}), controlled by player ${link.player}.`,
    `Full text: ${card.text}`,
    `The effect being used (effect ${link.effect} of its sheet): kind ${effect.kind}; window: ${effect.window || 'none given'}; cost: ${effect.cost || 'none'}; targets: ${effect.targets ?? 'none'}; effect: ${effect.effect}`,
  ].join('\n');
}

/** What the effect answers, and the chain below it. */
function context(state: DuelState, link: ChainLink): string {
  const lines = [`It is activated for: ${link.cause ? describeHappening(state, link.cause) : 'nothing (it answers no event)'}.`];
  const below = state.chain.filter((l) => l !== link && state.chain.indexOf(l) < state.chain.indexOf(link));
  if (below.length) lines.push(`Chain below it (link 1 first): ${below.map((l, i) => `${i + 1}. ${l.card} ${cardOf(state, l.card).name} (player ${l.player})`).join('; ')}.`);
  return lines.join('\n');
}

/** An event in the judge's words, with card IDs. */
function describeHappening(state: DuelState, h: Happening): string {
  const label = (id: string) => `${id} ${cardOf(state, id).name}`;
  switch (h.event) {
    case 'summoned':
      return `player ${h.player} ${summonName[h.how]} Summoned ${label(h.card)}`;
    case 'attack_declared':
      return `player ${h.player}'s ${label(h.card)} declared an attack ${h.target ? `on ${label(h.target)}` : 'directly'}`;
    case 'attacked':
      return `player ${h.player}'s ${label(h.card)} was targeted for an attack by ${label(h.attacker)}`;
    case 'destroyed_by_battle':
      return `player ${h.player}'s ${label(h.card)} was destroyed by battle`;
    case 'battle_destroying':
      return `player ${h.player}'s ${label(h.card)} destroyed ${label(h.target)} by battle`;
    case 'battle_damage':
      return `player ${h.player}'s ${label(h.card)} inflicted ${h.amount} battle damage to the opponent`;
    case 'activated':
      return `player ${h.player} activated ${label(h.card)} (chain link ${h.link + 1})`;
    case 'phase':
      return `the start of player ${h.player}'s ${PHASE_NAMES[h.phase]}`;
    case 'destroyed_by_effect':
      return `player ${h.player}'s ${h.faceUp ? 'face-up' : 'face-down'} ${label(h.card)} was destroyed by player ${h.by}'s card effect`;
    case 'damage_step_end':
      return `the Damage Step of player ${h.player}'s ${label(h.card)}'s attack ${h.target ? `on ${label(h.target)}` : 'directly'} ended`;
    case 'damage_step_start':
      return `the Damage Step of player ${h.player}'s ${label(h.card)}'s attack ${h.target ? `on ${label(h.target)}` : 'directly'} started`;
    case 'sent_to_graveyard':
      return `player ${h.player}'s ${label(h.card)} was sent from the field to the GY`;
    case 'flipped':
      return `player ${h.player}'s ${label(h.card)} was flipped face-up`;
  }
}

export function activationRequest(state: DuelState, link: ChainLink, appealRuling: string | null): string {
  const appeal = appealRuling ? `\nAn appeal already ruled this activation legal on this board, and that ruling binds: ${appealRuling} Pay its cost and declare its targets.` : '';
  return `${describeState(state, link.card)}\n\n# Request: check an activation\nPlayer ${link.player} is activating this effect.${appeal}\n${context(state, link)}\n${describeEffect(state, link)}`;
}

export function resolutionRequest(state: DuelState, link: ChainLink, appealRuling: string | null): string {
  const targets = link.targets.length ? link.targets.map((id) => `${id} ${cardOf(state, id).name}`).join('; ') : 'none';
  const appeal = appealRuling ? ` An appeal overturned an earlier resolution of this effect on this board, and its ruling binds: ${appealRuling}` : '';
  return `${describeState(state)}\n\n# Request: resolve the effect\nThe activation was legal and its cost is paid.${appeal} Targets declared on activation: ${targets}.${link.choice ? ` Effect chosen on activation: ${link.choice}.` : ''}\n${context(state, link)}\n${describeEffect(state, link)}`;
}
