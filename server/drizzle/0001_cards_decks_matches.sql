CREATE TYPE "public"."match_status" AS ENUM('waiting', 'active', 'finished');--> statement-breakpoint
CREATE TABLE "card_imports" (
	"id" serial PRIMARY KEY NOT NULL,
	"database_version" text NOT NULL,
	"card_count" integer NOT NULL,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cards" (
	"id" integer PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"frame_type" text NOT NULL,
	"text" text NOT NULL,
	"text_hash" text NOT NULL,
	"atk" integer,
	"def" integer,
	"level" integer,
	"race" text NOT NULL,
	"attribute" text,
	"archetype" text,
	"raw" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "decks" (
	"id" serial PRIMARY KEY NOT NULL,
	"slug" text,
	"name" text NOT NULL,
	"main" integer[] NOT NULL,
	"extra" integer[] NOT NULL,
	CONSTRAINT "decks_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "match_events" (
	"match_id" text NOT NULL,
	"seq" integer NOT NULL,
	"event" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "match_events_match_id_seq_pk" PRIMARY KEY("match_id","seq")
);
--> statement-breakpoint
CREATE TABLE "matches" (
	"id" text PRIMARY KEY NOT NULL,
	"created_by" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" "match_status" DEFAULT 'waiting' NOT NULL,
	"seat0" text NOT NULL,
	"seat1" text,
	"deck0" integer NOT NULL,
	"deck1" integer
);
--> statement-breakpoint
ALTER TABLE "match_events" ADD CONSTRAINT "match_events_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matches" ADD CONSTRAINT "matches_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matches" ADD CONSTRAINT "matches_deck0_decks_id_fk" FOREIGN KEY ("deck0") REFERENCES "public"."decks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matches" ADD CONSTRAINT "matches_deck1_decks_id_fk" FOREIGN KEY ("deck1") REFERENCES "public"."decks"("id") ON DELETE no action ON UPDATE no action;