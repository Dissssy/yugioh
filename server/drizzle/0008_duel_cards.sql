ALTER TABLE "matches" ADD COLUMN "name0" text;--> statement-breakpoint
ALTER TABLE "matches" ADD COLUMN "name1" text;--> statement-breakpoint
ALTER TABLE "matches" ADD COLUMN "result" jsonb;--> statement-breakpoint
UPDATE "matches" m SET "name0" = e."event"->'players'->0->>'name', "name1" = e."event"->'players'->1->>'name'
  FROM "match_events" e WHERE e."match_id" = m."id" AND e."seq" = 0;--> statement-breakpoint
UPDATE "matches" m SET "name0" = u."username" FROM "users" u WHERE m."name0" IS NULL AND u."id" = m."created_by";--> statement-breakpoint
UPDATE "matches" m SET "result" = (e."event"->'result') || jsonb_build_object('turn', coalesce(
    (SELECT max((t."event"->>'turn')::int) FROM "match_events" t WHERE t."match_id" = m."id" AND t."event"->>'type' = 'turnStarted'), 0))
  FROM "match_events" e WHERE e."match_id" = m."id" AND e."event"->>'type' = 'duelEnded';--> statement-breakpoint
ALTER TABLE "matches" ALTER COLUMN "name0" SET NOT NULL;
