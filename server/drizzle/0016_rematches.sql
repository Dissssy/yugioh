ALTER TABLE "matches" ADD COLUMN "rematch_of" text;--> statement-breakpoint
ALTER TABLE "matches" ADD CONSTRAINT "matches_rematch_of_matches_id_fk" FOREIGN KEY ("rematch_of") REFERENCES "public"."matches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matches" ADD CONSTRAINT "matches_rematch_of_unique" UNIQUE("rematch_of");