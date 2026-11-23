ALTER TABLE "matches" DROP CONSTRAINT "matches_deck0_decks_id_fk";
--> statement-breakpoint
ALTER TABLE "matches" DROP CONSTRAINT "matches_deck1_decks_id_fk";
--> statement-breakpoint
-- Duels keep a copy of each deck instead of pointing at it, so players can edit and delete their decks.
ALTER TABLE "matches" ADD COLUMN "deck0_copy" jsonb;--> statement-breakpoint
ALTER TABLE "matches" ADD COLUMN "deck1_copy" jsonb;--> statement-breakpoint
UPDATE "matches" m SET "deck0_copy" = jsonb_build_object('name', d.name, 'main', to_jsonb(d.main), 'extra', to_jsonb(d.extra)) FROM "decks" d WHERE d.id = m.deck0;--> statement-breakpoint
UPDATE "matches" m SET "deck1_copy" = jsonb_build_object('name', d.name, 'main', to_jsonb(d.main), 'extra', to_jsonb(d.extra)) FROM "decks" d WHERE d.id = m.deck1;--> statement-breakpoint
ALTER TABLE "matches" DROP COLUMN "deck0";--> statement-breakpoint
ALTER TABLE "matches" DROP COLUMN "deck1";--> statement-breakpoint
ALTER TABLE "matches" RENAME COLUMN "deck0_copy" TO "deck0";--> statement-breakpoint
ALTER TABLE "matches" RENAME COLUMN "deck1_copy" TO "deck1";--> statement-breakpoint
ALTER TABLE "matches" ALTER COLUMN "deck0" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "decks" ADD COLUMN "owner_id" integer;--> statement-breakpoint
ALTER TABLE "decks" ADD COLUMN "side" integer[] DEFAULT '{}'::integer[] NOT NULL;--> statement-breakpoint
ALTER TABLE "decks" ADD COLUMN "shared" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "decks" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "decks" ADD CONSTRAINT "decks_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;