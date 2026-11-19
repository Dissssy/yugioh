// Usernames: the only name other people see for an account. New accounts get a random one built from
// Yu-Gi-Oh words, Reddit style, and can change it to any free name as often as they like.

import { randomInt } from 'node:crypto';
import { z } from 'zod';

const ADJECTIVES = [
  'Ancient', 'Arcane', 'Blazing', 'Celestial', 'Chaos', 'Cursed', 'Cyber', 'Dark', 'Divine', 'Elemental',
  'Eternal', 'Fiendish', 'Forbidden', 'Frozen', 'Gilded', 'Hidden', 'Infernal', 'Legendary', 'Lunar', 'Mystic',
  'Obelisk', 'Phantom', 'Radiant', 'Raging', 'Sacred', 'Shadow', 'Solar', 'Spellbound', 'Storm', 'Swift',
  'Thunder', 'Toon', 'Twilight', 'Valiant', 'Wicked', 'Winged',
];

const NOUNS = [
  'Banisher', 'Chimera', 'Duelist', 'Dragon', 'Dreadnought', 'Fairy', 'Fiend', 'Fusion', 'Gazelle', 'Golem',
  'Graveyard', 'Guardian', 'Kuriboh', 'Knight', 'Magician', 'Monarch', 'Necrovalley', 'Pendulum', 'Pharaoh',
  'Ritual', 'Serpent', 'Sorcerer', 'Spellcaster', 'Synchro', 'Tribute', 'Trapper', 'Warrior', 'Wyrm', 'Wyvern',
  'Xyz', 'Zombie',
];

const pick = (words: string[]) => words[randomInt(words.length)]!;

/** A random name such as `Mystic_Kuriboh_4821`. */
export const randomUsername = () => `${pick(ADJECTIVES)}_${pick(NOUNS)}_${randomInt(10_000)}`;

export const username = z
  .string()
  .trim()
  .min(3)
  .max(32)
  .regex(/^[A-Za-z0-9_-]+$/);
