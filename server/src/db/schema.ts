import { boolean, integer, jsonb, pgEnum, pgTable, primaryKey, serial, text, timestamp } from 'drizzle-orm/pg-core';

export const accountStatus = pgEnum('account_status', ['pending', 'approved', 'rejected']);

export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  auth0Sub: text('auth0_sub').notNull().unique(),
  email: text('email'),
  name: text('name'),
  status: accountStatus('status').notNull().default('pending'),
  isAdmin: boolean('is_admin').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Someone without an account who accepted a challenge link. The signed `guest` cookie holds the token.
 * A guest lasts while they sit in a duel that is going or finished recently; see guests.ts.
 */
export const guests = pgTable('guests', {
  id: serial('id').primaryKey(),
  token: text('token').notNull().unique(),
  name: text('name').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Every card from YGOPRODeck. The game reads cards from here and never calls the API live. */
export const cards = pgTable('cards', {
  id: integer('id').primaryKey(), // the card's passcode
  name: text('name').notNull(),
  type: text('type').notNull(),
  frameType: text('frame_type').notNull(),
  text: text('text').notNull(),
  /** sha256 of the text; when errata changes it, the card's effect sheet must be recompiled. */
  textHash: text('text_hash').notNull(),
  atk: integer('atk'),
  def: integer('def'),
  level: integer('level'),
  race: text('race').notNull(),
  attribute: text('attribute'),
  archetype: text('archetype'),
  /** The card as YGOPRODeck returned it, minus prices. */
  raw: jsonb('raw').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Bookkeeping for the card import: the YGOPRODeck database version last imported. */
export const cardImports = pgTable('card_imports', {
  id: serial('id').primaryKey(),
  databaseVersion: text('database_version').notNull(),
  cardCount: integer('card_count').notNull(),
  importedAt: timestamp('imported_at', { withTimezone: true }).notNull().defaultNow(),
});

/** A decklist. Premade decks have a slug and no owner. */
export const decks = pgTable('decks', {
  id: serial('id').primaryKey(),
  slug: text('slug').unique(),
  name: text('name').notNull(),
  main: integer('main').array().notNull(),
  extra: integer('extra').array().notNull(),
});

export const matchStatus = pgEnum('match_status', ['waiting', 'active', 'finished']);

/** A duel between two seats. Seat keys are `user:<id>` or `guest:<id>`; only accounts create duels. */
export const matches = pgTable('matches', {
  id: text('id').primaryKey(),
  createdBy: integer('created_by')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  status: matchStatus('status').notNull().default('waiting'),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  seat0: text('seat0').notNull(),
  seat1: text('seat1'),
  deck0: integer('deck0')
    .notNull()
    .references(() => decks.id),
  deck1: integer('deck1').references(() => decks.id),
});

/** The duel's append-only event log. The board is the fold of these events. */
export const matchEvents = pgTable(
  'match_events',
  {
    matchId: text('match_id')
      .notNull()
      .references(() => matches.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    event: jsonb('event').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.matchId, t.seq] })],
);
