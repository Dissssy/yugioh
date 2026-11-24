ALTER TABLE "matches" ADD COLUMN "place" text;--> statement-breakpoint
CREATE INDEX "matches_place" ON "matches" USING btree ("place","created_at");