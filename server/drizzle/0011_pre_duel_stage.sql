ALTER TYPE "public"."match_status" ADD VALUE 'preparing' BEFORE 'active';--> statement-breakpoint
ALTER TABLE "matches" ALTER COLUMN "deck0" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "matches" ADD COLUMN "premade_only" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "matches" ADD COLUMN "ready0" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "matches" ADD COLUMN "ready1" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- Decks brought to earlier duels had no Side Deck. Duels that already started had both players ready.
UPDATE "matches" SET "deck0" = "deck0" || '{"side":[],"premade":false}'::jsonb WHERE "deck0" IS NOT NULL;--> statement-breakpoint
UPDATE "matches" SET "deck1" = "deck1" || '{"side":[],"premade":false}'::jsonb WHERE "deck1" IS NOT NULL;--> statement-breakpoint
UPDATE "matches" SET "ready0" = true, "ready1" = true WHERE "status" IN ('active', 'finished');
