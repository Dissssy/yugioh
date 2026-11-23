CREATE TABLE "banlists" (
	"id" serial PRIMARY KEY NOT NULL,
	"slug" text,
	"owner_id" integer,
	"name" text NOT NULL,
	"limits" jsonb NOT NULL,
	"shared" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "banlists_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
ALTER TABLE "decks" ADD COLUMN "banlist_id" integer;--> statement-breakpoint
-- Duels from before banlists were played without one.
ALTER TABLE "matches" ADD COLUMN "banlist" jsonb NOT NULL DEFAULT '{"name":"No list","limits":{}}'::jsonb;--> statement-breakpoint
ALTER TABLE "matches" ALTER COLUMN "banlist" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "banlists" ADD CONSTRAINT "banlists_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decks" ADD CONSTRAINT "decks_banlist_id_banlists_id_fk" FOREIGN KEY ("banlist_id") REFERENCES "public"."banlists"("id") ON DELETE set null ON UPDATE no action;