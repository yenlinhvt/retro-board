CREATE TABLE "action_items" (
	"id" text PRIMARY KEY NOT NULL,
	"board_id" text NOT NULL,
	"text" text NOT NULL,
	"owner" text DEFAULT '' NOT NULL,
	"note_id" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "atlassian_connection" (
	"id" integer PRIMARY KEY NOT NULL,
	"cloud_id" text,
	"site_url" text,
	"site_name" text,
	"access_token_enc" text NOT NULL,
	"refresh_token_enc" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"default_space_id" text,
	"default_space_name" text,
	"default_parent_id" text,
	"default_parent_title" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "boards" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"admin_token_hash" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"columns" jsonb NOT NULL,
	"vote_limit" integer DEFAULT 5 NOT NULL,
	"timer" jsonb DEFAULT '{"status":"idle","durationMs":300000,"endsAt":null,"remainingMs":300000}'::jsonb NOT NULL,
	"confluence_space_id" text,
	"confluence_space_name" text,
	"confluence_parent_id" text,
	"confluence_parent_title" text,
	"confluence_page_id" text,
	"confluence_page_version" integer,
	"confluence_page_url" text,
	"export_status" text DEFAULT 'idle' NOT NULL,
	"export_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "notes" (
	"id" text PRIMARY KEY NOT NULL,
	"board_id" text NOT NULL,
	"author_id" text NOT NULL,
	"column_index" integer NOT NULL,
	"text" text NOT NULL,
	"is_public" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"shared_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "participants" (
	"id" text PRIMARY KEY NOT NULL,
	"board_id" text NOT NULL,
	"client_id" text NOT NULL,
	"public_id" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "participants_board_client_unique" UNIQUE("board_id","client_id")
);
--> statement-breakpoint
CREATE TABLE "votes" (
	"id" text PRIMARY KEY NOT NULL,
	"board_id" text NOT NULL,
	"note_id" text NOT NULL,
	"participant_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "action_items" ADD CONSTRAINT "action_items_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "action_items" ADD CONSTRAINT "action_items_note_id_notes_id_fk" FOREIGN KEY ("note_id") REFERENCES "public"."notes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "action_items" ADD CONSTRAINT "action_items_created_by_participants_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."participants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_author_id_participants_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."participants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "participants" ADD CONSTRAINT "participants_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "votes" ADD CONSTRAINT "votes_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "votes" ADD CONSTRAINT "votes_note_id_notes_id_fk" FOREIGN KEY ("note_id") REFERENCES "public"."notes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "votes" ADD CONSTRAINT "votes_participant_id_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."participants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notes_board_idx" ON "notes" USING btree ("board_id");--> statement-breakpoint
CREATE INDEX "votes_board_participant_idx" ON "votes" USING btree ("board_id","participant_id");