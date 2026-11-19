CREATE TYPE "public"."account_role" AS ENUM('player', 'admin', 'superAdmin');--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "role" "account_role" DEFAULT 'player' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "is_admin";