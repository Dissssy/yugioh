CREATE TABLE "discord_servers" (
	"id" text PRIMARY KEY NOT NULL,
	"trusted" boolean DEFAULT false NOT NULL,
	"last_opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_opened_by" integer
);
--> statement-breakpoint
ALTER TABLE "discord_servers" ADD CONSTRAINT "discord_servers_last_opened_by_users_id_fk" FOREIGN KEY ("last_opened_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;