ALTER TABLE "users" ALTER COLUMN "auth0_sub" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "discord_id" text;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_discord_id_unique" UNIQUE("discord_id");--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_has_login" CHECK ("users"."auth0_sub" is not null or "users"."discord_id" is not null);