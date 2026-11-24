import { sql } from 'drizzle-orm';
import type { EffectSheet } from '@yugioh/engine';
import type { Banlist, DuelDeck, DuelOutcome, UserSettings } from '@yugioh/shared';
import { boolean, check, foreignKey, index, integer, jsonb, pgEnum, pgTable, primaryKey, serial, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

export const accountStatus = pgEnum('account_status', ['pending', 'approved', 'rejected']);
export const accountRole = pgEnum('account_role', ['player', 'admin', 'superAdmin']);

/**
 * An account. It signs in through Auth0 on the website, through Discord in the Activity, or both once linked.
 * Only the admin ever sees the email; everyone else sees the username.
 */
export const users = pgTable(
  'users',
  {
    id: serial('id').primaryKey(),
    auth0Sub: text('auth0_sub').unique(),
    discordId: text('discord_id').unique(),
    email: text('email'),
    username: text('username').notNull(),
    status: accountStatus('status').notNull().default('pending'),
    role: accountRole('role').notNull().default('player'),
    /** Only the settings the account has changed; the rest take the defaults in @yugioh/shared. */
    settings: jsonb('settings').$type<Partial<UserSettings>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  // Usernames are unique regardless of case, so `Yugi` and `yugi` can't both exist.
  (t) => [
    uniqueIndex('users_username_lower_unique').on(sql`lower(${t.username})`),
    check('users_has_login', sql`${t.auth0Sub} is not null or ${t.discordId} is not null`),
  ],
);

/**
 * A Discord server the Activity has been opened in (docs/discord.md), recorded on each launch. An admin marks the
 * servers whose players are approved automatically. Discord tells an app a server's name only through a bot, which the
 * app doesn't have, so the admin tells servers apart by who opened the Activity there.
 */
export const discordServers = pgTable('discord_servers', {
  id: text('id').primaryKey(),
  trusted: boolean('trusted').notNull().default(false),
  lastOpenedAt: timestamp('last_opened_at', { withTimezone: true }).notNull().defaultNow(),
  lastOpenedBy: integer('last_opened_by').references(() => users.id, { onDelete: 'set null' }),
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

/**
 * A browser that gets Web Push notifications for a player (an account's or a guest's seat key, as in matches), while
 * the site is closed there (push.ts).
 */
export const pushSubscriptions = pgTable(
  'push_subscriptions',
  {
    endpoint: text('endpoint').primaryKey(),
    seatKey: text('seat_key').notNull(),
    p256dh: text('p256dh').notNull(),
    auth: text('auth').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('push_subscriptions_seat_key').on(t.seatKey)],
);

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

/**
 * A banlist (docs/deck-builder.md, Banlists): copies allowed of each listed card, keyed by passcode. The default lists
 * have a slug and no owner, and every card import rebuilds them; players' lists have an owner.
 */
export const banlists = pgTable('banlists', {
  id: serial('id').primaryKey(),
  slug: text('slug').unique(),
  ownerId: integer('owner_id').references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  limits: jsonb('limits').$type<Record<string, number>>().notNull(),
  shared: boolean('shared').notNull().default(false),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * A decklist (docs/deck-builder.md). Premade decks have a slug and no owner; players' decks have an owner and no slug.
 * A deck is saved whether or not it's legal: the rules are checked when it goes into a duel.
 */
export const decks = pgTable('decks', {
  id: serial('id').primaryKey(),
  slug: text('slug').unique(),
  ownerId: integer('owner_id').references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  main: integer('main').array().notNull(),
  extra: integer('extra').array().notNull(),
  side: integer('side').array().notNull().default(sql`'{}'::integer[]`),
  /** The banlist the deck is built for; its legality on the decks page is under this list. Null is the default list. */
  banlistId: integer('banlist_id').references(() => banlists.id, { onDelete: 'set null' }),
  /** Anyone with the link may see it and copy it. */
  shared: boolean('shared').notNull().default(false),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const matchStatus = pgEnum('match_status', ['waiting', 'preparing', 'active', 'finished']);

/** A duel between two seats. Seat keys are `user:<id>` or `guest:<id>`; only accounts create duels. */
export const matches = pgTable(
  'matches',
  {
    id: text('id').primaryKey(),
    createdBy: integer('created_by')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    status: matchStatus('status').notNull().default('waiting'),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    seat0: text('seat0').notNull(),
    seat1: text('seat1'),
    /** The players' names as the duel shows them, kept from when they took their seats. */
    name0: text('name0').notNull(),
    name1: text('name1'),
    /** How the duel ended, once it has. */
    result: jsonb('result').$type<DuelOutcome>(),
    /** The banlist both decks must follow, copied when the challenge was made. */
    banlist: jsonb('banlist').$type<Banlist>().notNull(),
    premadeOnly: boolean('premade_only').notNull().default(false),
    /** Each player's copy of their deck for this duel, chosen in the pre-duel stage; the duel starts from it. */
    deck0: jsonb('deck0').$type<DuelDeck>(),
    deck1: jsonb('deck1').$type<DuelDeck>(),
    ready0: boolean('ready0').notNull().default(false),
    ready1: boolean('ready1').notNull().default(false),
    /** `guild:<id>` or `dm:<id>`: whose open games show this duel, when it was started in the Activity (docs/discord.md). */
    place: text('place'),
    /**
     * The duel this one is a rematch of: the same players, seats, banlist and decks. A duel has at most one rematch, so
     * the duels of a series (a later best of three) follow each other through this.
     */
    rematchOf: text('rematch_of').unique(),
  },
  (t) => [index('matches_place').on(t.place, t.createdAt), foreignKey({ columns: [t.rematchOf], foreignColumns: [t.id] }).onDelete('set null')],
);

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

/**
 * Each card's effect sheet as it is now (see docs/effects.md). The database is where sheets live and change: the
 * compiler, players' reports and the admin all write here. `npm run sheets:export` copies them to files for diffing.
 */
export const effectSheets = pgTable('effect_sheets', {
  code: integer('code')
    .primaryKey()
    .references(() => cards.id, { onDelete: 'cascade' }),
  sheet: jsonb('sheet').$type<EffectSheet>().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Every version a sheet has had, newest last, with why it changed. */
export const sheetRevisions = pgTable('sheet_revisions', {
  id: serial('id').primaryKey(),
  code: integer('code')
    .notNull()
    .references(() => cards.id, { onDelete: 'cascade' }),
  sheet: jsonb('sheet').$type<EffectSheet>().notNull(),
  /** "compiled", "imported", "reported", "appeal overturned a scripted ruling", or the admin's note. */
  reason: text('reason').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * A player's report that a card is ruled wrongly, an appeal that overturned a scripted ruling, or an escalated
 * question that found a card or a rule in code wrong. `code` is null for a rule in code. `seq` is how many events the
 * duel had, so the board it was made on can be replayed. Open until the admin resolves it.
 */
export const sheetReports = pgTable('sheet_reports', {
  id: serial('id').primaryKey(),
  code: integer('code').references(() => cards.id, { onDelete: 'cascade' }),
  matchId: text('match_id')
    .notNull()
    .references(() => matches.id, { onDelete: 'cascade' }),
  seq: integer('seq').notNull(),
  /** The reporting seat key, "appeal" or "escalation". */
  reporter: text('reporter').notNull(),
  note: text('note').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
});
