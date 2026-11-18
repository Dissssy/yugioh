CREATE TABLE "guests" (
	"id" serial PRIMARY KEY NOT NULL,
	"token" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "guests_token_unique" UNIQUE("token")
);
--> statement-breakpoint
DROP TABLE "invites" CASCADE;--> statement-breakpoint
ALTER TABLE "matches" ADD COLUMN "finished_at" timestamp with time zone;