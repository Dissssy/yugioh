CREATE TABLE "effect_sheets" (
	"code" integer PRIMARY KEY NOT NULL,
	"sheet" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sheet_reports" (
	"id" serial PRIMARY KEY NOT NULL,
	"code" integer NOT NULL,
	"match_id" text NOT NULL,
	"seq" integer NOT NULL,
	"reporter" text NOT NULL,
	"note" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "sheet_revisions" (
	"id" serial PRIMARY KEY NOT NULL,
	"code" integer NOT NULL,
	"sheet" jsonb NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "effect_sheets" ADD CONSTRAINT "effect_sheets_code_cards_id_fk" FOREIGN KEY ("code") REFERENCES "public"."cards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sheet_reports" ADD CONSTRAINT "sheet_reports_code_cards_id_fk" FOREIGN KEY ("code") REFERENCES "public"."cards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sheet_reports" ADD CONSTRAINT "sheet_reports_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sheet_revisions" ADD CONSTRAINT "sheet_revisions_code_cards_id_fk" FOREIGN KEY ("code") REFERENCES "public"."cards"("id") ON DELETE cascade ON UPDATE no action;