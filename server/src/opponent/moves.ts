// The AI opponent's options, built only from what its seat sees. Code turns each legal action into complete moves (all
// choices filled in), so the model only ever picks a number and can't make an illegal or malformed move.

import {
  EXTRA_MONSTER_ZONES,
  type CardView,
  type FieldCardView,
  type Intent,
  type JudgingView,
  type LegalAction,
  type PlayerView,
  type Place,
  type Position,
  type Seat,
} from '@yugioh/engine';

export interface Move {
  text: string;
  intent: Intent;
}

/** Card names by instance ID, for every card the seat can see. */
function namesIn(view: PlayerView): Map<string, string> {
  const names = new Map<string, string>();
  const add = (c: CardView | null | undefined) => {
    if (c && 'id' in c) names.set(c.id, c.card.name);
  };
  for (const p of view.players) {
    for (const list of [p.hand, p.graveyard, p.banished, p.extra]) list.forEach(add);
    for (const f of [...p.monsters, ...p.spellTraps]) {
      add(f?.card);
      f?.materials.forEach(add);
    }
  }
  for (const link of view.chain) add(link.card);
  return names;
}

const PLACES: Record<Place, string> = { deck: 'Deck', hand: 'hand', monsters: 'Monster Zone', spellTraps: 'Spell & Trap Zone', materials: 'Xyz Materials', graveyard: 'GY', banished: 'banished cards', extra: 'Extra Deck' };

export const zoneName = (zone: number) => (EXTRA_MONSTER_ZONES.includes(zone as 5 | 6) ? `Extra Monster Zone ${zone - 4}` : `zone ${zone + 1}`);

/** Every way to choose `count` of `from`, in order. */
function combinations<T>(from: T[], count: number): T[][] {
  if (count === 0) return [[]];
  return from.flatMap((first, i) => combinations(from.slice(i + 1), count - 1).map((rest) => [first, ...rest]));
}

/**
 * The moves the AI may make now, one per complete intent. Left out: surrender, and what code answers by itself
 * (rock-paper-scissors, who goes first, rollback offers).
 */
export function movesFor(view: PlayerView): Move[] {
  const names = namesIn(view);
  const name = (id: string) => names.get(id) ?? 'a card';
  const me = view.players[view.you];
  const them = view.players[view.you === 0 ? 1 : 0];
  const zoneOf = (id: string) => me.monsters.findIndex((m) => m?.card && 'id' in m.card && m.card.id === id);
  const target = (zone: number) => {
    const m = them.monsters[zone];
    return m && 'id' in m.card ? `${m.card.card.name} (${zoneName(zone)}, ${describeStats(m)})` : `the face-down monster in ${zoneName(zone)}`;
  };
  return view.actions.flatMap((action: LegalAction): Move[] => {
    switch (action.type) {
      case 'normalSummon':
      case 'setMonster': {
        const verb = action.type === 'normalSummon' ? 'Normal Summon' : 'Set';
        return combinations(action.tributeFrom, action.tributes).flatMap((tributes) => {
          // A tribute's zone is free for the monster it makes way for.
          const zone = action.zones.find((z) => me.monsters[z] === null || tributes.some((t) => zoneOf(t) === z));
          if (zone === undefined) return [];
          const by = tributes.length ? `, tributing ${tributes.map(name).join(' and ')}` : '';
          return [{ text: `${verb} ${name(action.card)}${by}`, intent: { type: action.type, card: action.card, tributes, zone } }];
        });
      }
      case 'setSpellTrap':
        return [{ text: `Set ${name(action.card)}`, intent: { type: 'setSpellTrap', card: action.card, zone: action.zones[0]! } }];
      case 'flipSummon':
        return [{ text: `Flip Summon ${name(action.card)}`, intent: { type: 'flipSummon', card: action.card } }];
      case 'changePosition':
        return [{ text: `Change the battle position of ${name(action.card)}`, intent: { type: 'changePosition', card: action.card } }];
      case 'enterBattle':
        return [{ text: 'Go to the Battle Phase', intent: { type: 'enterBattle' } }];
      case 'enterMain2':
        return [{ text: 'End the Battle Phase and go to Main Phase 2', intent: { type: 'enterMain2' } }];
      case 'attack': {
        const moves: Move[] = action.targets.map((zone) => ({
          text: `Attack ${target(zone)} with ${name(action.attacker)}`,
          intent: { type: 'attack', attacker: action.attacker, target: zone },
        }));
        if (action.direct) moves.push({ text: `Attack directly with ${name(action.attacker)}`, intent: { type: 'attack', attacker: action.attacker, target: 'direct' } });
        return moves;
      }
      case 'endTurn':
        return combinations(me.hand.flatMap((c) => ('id' in c ? [c.id] : [])), action.discard).map((discard) => ({
          text: discard.length ? `End the turn, discarding ${discard.map(name).join(' and ')} for the hand size limit` : 'End the turn',
          intent: { type: 'endTurn', discard },
        }));
      case 'extraSummon': {
        const how = action.how === 'synchro' ? 'Synchro' : 'Xyz';
        return action.options.flatMap((o) =>
          (['attack', 'defense'] as Position[]).map((position) => ({
            text: `${how} Summon ${name(action.card)} in ${position} position, using ${o.materials.map(name).join(' and ')}`,
            intent: { type: 'extraSummon', card: action.card, materials: o.materials, zone: o.zones[0]!, position },
          })),
        );
      }
      case 'activate':
        return [
          {
            text: `Activate ${name(action.card)}: ${action.text}`,
            intent: { type: 'activate', card: action.card, effect: action.effect, zone: action.zones?.[0] ?? null },
          },
        ];
      case 'pass':
        return [{ text: view.waiting?.for === 'triggers' ? "Don't activate any optional trigger" : 'Pass (respond with nothing)', intent: { type: 'pass' } }];
      case 'replace':
        return [
          { text: `Detach ${action.count} Xyz Material from ${name(action.card)} instead of it being destroyed`, intent: { type: 'replace', materials: action.materials.slice(0, action.count) } },
          { text: `Let ${name(action.card)} be destroyed`, intent: { type: 'replace', materials: [] } },
        ];
      case 'rollback':
      case 'rps':
      case 'chooseOrder':
      case 'surrender':
        return [];
    }
  });
}

/** A face-up monster's position and current stats. */
export function describeStats(m: FieldCardView): string {
  const s = m.stats;
  const stats = s ? `${s.level !== null ? `Level ${s.level}, ` : ''}ATK ${s.atk} / DEF ${s.def}` : '';
  return [m.position === 'attack' ? 'attack position' : 'defense position', stats].filter(Boolean).join(', ');
}

/** A judge question as numbered options: the cards it offers, then its other choices. `pick` is what the server takes. */
export function optionsFor(prompt: NonNullable<JudgingView['prompt']>, you: Seat): { text: string; pick: string }[] {
  return [
    ...prompt.cards.map((c) => ({
      text: `${'id' in c.card ? c.card.card.name : 'a face-down card'} (${c.seat === you ? 'your' : "your opponent's"} ${PLACES[c.place]}${c.zone !== null ? `, ${zoneName(c.zone)}` : ''})`,
      pick: c.pick,
    })),
    ...prompt.choices.map((choice) => ({ text: choice, pick: choice })),
  ];
}

/**
 * What the AI plays when it can't ask the model (an API error, an answer that doesn't fit): pass, or move the turn
 * on, so the duel never hangs on it.
 */
export function safeMove(moves: Move[]): Move {
  const order: Intent['type'][] = ['pass', 'enterMain2', 'endTurn'];
  for (const type of order) {
    const move = moves.find((m) => m.intent.type === type);
    if (move) return move;
  }
  return moves[0]!;
}
