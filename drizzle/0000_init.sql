CREATE TYPE "public"."appointment_source" AS ENUM('manual', 'doctolib', 'online', 'phone', 'whatsapp', 'email', 'voice_agent');--> statement-breakpoint
CREATE TYPE "public"."appointment_status" AS ENUM('planned', 'confirmed', 'done', 'cancelled', 'no_show');--> statement-breakpoint
CREATE TYPE "public"."billing_contact_kind" AS ENUM('guardian', 'relative', 'care_home', 'other');--> statement-breakpoint
CREATE TYPE "public"."channel" AS ENUM('email', 'whatsapp', 'sms', 'phone', 'letter', 'none');--> statement-breakpoint
CREATE TYPE "public"."consent_type" AS ENUM('privacy_notice', 'photo_documentation', 'photo_marketing', 'whatsapp', 'email_reminders', 'sms_reminders', 'marketing', 'review_request', 'ai_processing', 'call_recording', 'no_show_terms');--> statement-breakpoint
CREATE TYPE "public"."foot_side" AS ENUM('left', 'right');--> statement-breakpoint
CREATE TYPE "public"."insurance_type" AS ENUM('gkv', 'pkv', 'self', 'beihilfe');--> statement-breakpoint
CREATE TYPE "public"."integration_provider" AS ENUM('lexoffice', 'sumup', 'doctolib', 'google_business', 'email_imap', 'whatsapp', 'sms', 'voice_agent', 'transcription', 'llm', 'calendar_ics', 'stripe', 'gkv_billing');--> statement-breakpoint
CREATE TYPE "public"."integration_status" AS ENUM('disconnected', 'mock', 'connected', 'error');--> statement-breakpoint
CREATE TYPE "public"."invoice_kind" AS ENUM('invoice', 'receipt', 'collective', 'credit_note', 'no_show_fee');--> statement-breakpoint
CREATE TYPE "public"."invoice_status" AS ENUM('draft', 'issued', 'partially_paid', 'paid', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."media_kind" AS ENUM('photo', 'audio', 'document');--> statement-breakpoint
CREATE TYPE "public"."media_purpose" AS ENUM('brace_before', 'brace_progress', 'brace_complication', 'brace_after', 'finding', 'wound', 'document', 'prescription', 'voice_report', 'marketing');--> statement-breakpoint
CREATE TYPE "public"."message_direction" AS ENUM('inbound', 'outbound');--> statement-breakpoint
CREATE TYPE "public"."message_status" AS ENUM('new', 'suggested', 'answered', 'archived');--> statement-breakpoint
CREATE TYPE "public"."payment_method" AS ENUM('cash', 'card', 'transfer', 'voucher', 'payment_link');--> statement-breakpoint
CREATE TYPE "public"."role" AS ENUM('owner', 'therapist', 'reception', 'trainee', 'accountant');--> statement-breakpoint
CREATE TABLE "anamneses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"data" jsonb NOT NULL,
	"author_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "appointment_services" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"appointment_id" uuid NOT NULL,
	"service_id" uuid NOT NULL,
	"quantity" numeric(6, 2) DEFAULT '1' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "appointments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"location_id" uuid,
	"patient_id" uuid,
	"therapist_id" uuid,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"status" "appointment_status" DEFAULT 'planned' NOT NULL,
	"source" "appointment_source" DEFAULT 'manual' NOT NULL,
	"external_id" text,
	"title" text,
	"notes" text,
	"home_visit" boolean DEFAULT false NOT NULL,
	"prescription_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"organization_id" uuid,
	"user_id" uuid,
	"action" text NOT NULL,
	"entity" text,
	"entity_id" text,
	"ip" text,
	"meta" jsonb,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "billing_contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"kind" "billing_contact_kind" NOT NULL,
	"name" text NOT NULL,
	"street" text,
	"zip" text,
	"city" text,
	"email" text,
	"phone" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "brace_episodes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"side" "foot_side" NOT NULL,
	"toe" integer NOT NULL,
	"stage" text,
	"brace_type" text,
	"started_at" date NOT NULL,
	"ended_at" date,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "consents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"type" "consent_type" NOT NULL,
	"granted" boolean NOT NULL,
	"version" text DEFAULT '1' NOT NULL,
	"via" text,
	"recorded_by" uuid,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fixed_costs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"category" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"interval" text DEFAULT 'monthly' NOT NULL,
	"start_date" date NOT NULL,
	"note" text,
	"active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "integration_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider" "integration_provider" NOT NULL,
	"status" "integration_status" DEFAULT 'disconnected' NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"secret_enc" text,
	"last_sync_at" timestamp with time zone,
	"last_error" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoice_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"service_id" uuid,
	"description" text NOT NULL,
	"quantity" numeric(8, 2) DEFAULT '1' NOT NULL,
	"factor" numeric(5, 2) DEFAULT '1' NOT NULL,
	"unit_price_cents" integer NOT NULL,
	"vat_rate" integer DEFAULT 0 NOT NULL,
	"total_cents" integer NOT NULL,
	"position" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"patient_id" uuid,
	"billing_contact_id" uuid,
	"number" text,
	"kind" "invoice_kind" DEFAULT 'invoice' NOT NULL,
	"status" "invoice_status" DEFAULT 'draft' NOT NULL,
	"issued_at" date,
	"due_at" date,
	"net_cents" integer DEFAULT 0 NOT NULL,
	"vat_cents" integer DEFAULT 0 NOT NULL,
	"total_cents" integer DEFAULT 0 NOT NULL,
	"paid_cents" integer DEFAULT 0 NOT NULL,
	"cancels_invoice_id" uuid,
	"external_ref" text,
	"external_synced_at" timestamp with time zone,
	"notes" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "locations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"street" text,
	"zip" text,
	"city" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "media" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"record_id" uuid,
	"brace_episode_id" uuid,
	"kind" "media_kind" NOT NULL,
	"purpose" "media_purpose" NOT NULL,
	"storage_key" text NOT NULL,
	"mime" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"sha256" text NOT NULL,
	"foot_side" "foot_side",
	"toe" integer,
	"view" text,
	"caption" text,
	"taken_at" timestamp with time zone DEFAULT now() NOT NULL,
	"uploaded_by" uuid NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "role" NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"color" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"patient_id" uuid,
	"channel" "channel" NOT NULL,
	"direction" "message_direction" NOT NULL,
	"from_address" text,
	"to_address" text,
	"subject" text,
	"body" text NOT NULL,
	"status" "message_status" DEFAULT 'new' NOT NULL,
	"ai_suggestion" text,
	"external_id" text,
	"thread_key" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "news_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" text NOT NULL,
	"title" text NOT NULL,
	"url" text NOT NULL,
	"published_at" timestamp with time zone,
	"summary" text,
	"category" text DEFAULT 'allgemein' NOT NULL,
	"sponsored" boolean DEFAULT false NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "number_sequences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"key" text NOT NULL,
	"year" integer NOT NULL,
	"next" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"legal_name" text,
	"street" text,
	"zip" text,
	"city" text,
	"phone" text,
	"email" text,
	"tax_number" text,
	"vat_id" text,
	"iban" text,
	"small_business" boolean DEFAULT false NOT NULL,
	"state" text DEFAULT 'BB' NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organizations_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "patients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"salutation" text,
	"title" text,
	"last_name" text NOT NULL,
	"first_name" text,
	"birth_date" date,
	"street" text,
	"zip" text,
	"city" text,
	"phone_mobile" text,
	"phone_landline" text,
	"email" text,
	"preferred_channel" "channel" DEFAULT 'none' NOT NULL,
	"insurance_type" "insurance_type" DEFAULT 'self' NOT NULL,
	"insurer_name" text,
	"insurance_number" text,
	"gp_name" text,
	"notes" text,
	"risk_flags" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"visit_interval_weeks" integer,
	"home_visit" boolean DEFAULT false NOT NULL,
	"care_home_id" uuid,
	"billing_contact_id" uuid,
	"household_key" text,
	"source" text,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"method" "payment_method" NOT NULL,
	"amount_cents" integer NOT NULL,
	"paid_at" timestamp with time zone DEFAULT now() NOT NULL,
	"voucher_id" uuid,
	"external_ref" text,
	"created_by" uuid
);
--> statement-breakpoint
CREATE TABLE "prescriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"issued_at" date NOT NULL,
	"doctor_name" text,
	"doctor_lanr" text,
	"diagnosis_group" text NOT NULL,
	"icd10" text,
	"remedy" text,
	"units" integer NOT NULL,
	"frequency_per_week" text,
	"home_visit" boolean DEFAULT false NOT NULL,
	"urgent" boolean DEFAULT false NOT NULL,
	"copayment_exempt" boolean DEFAULT false NOT NULL,
	"start_by" date,
	"status" text DEFAULT 'open' NOT NULL,
	"billed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "record_addenda" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"record_id" uuid NOT NULL,
	"author_id" uuid NOT NULL,
	"kind" text DEFAULT 'addendum' NOT NULL,
	"text" text NOT NULL,
	"prev_hash" text,
	"hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider" text DEFAULT 'google' NOT NULL,
	"external_id" text NOT NULL,
	"author" text,
	"rating" integer,
	"text" text,
	"reply" text,
	"ai_suggestion" text,
	"created_at_external" timestamp with time zone,
	"replied_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "services" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"price_cents" integer NOT NULL,
	"vat_rate" integer DEFAULT 0 NOT NULL,
	"duration_min" integer DEFAULT 30 NOT NULL,
	"category" text DEFAULT 'treatment' NOT NULL,
	"gkv_position" text,
	"requires_therapeutic_purpose" boolean DEFAULT true NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"organization_id" uuid,
	"verified" boolean DEFAULT true NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"user_agent" text,
	"ip" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sterile_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"code" text NOT NULL,
	"sterilizer" text,
	"cycle_no" text,
	"processed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"released_by" uuid,
	"released_at" timestamp with time zone,
	"expires_at" date
);
--> statement-breakpoint
CREATE TABLE "sync_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"provider" "integration_provider" NOT NULL,
	"direction" text NOT NULL,
	"entity" text,
	"entity_id" text,
	"ok" boolean NOT NULL,
	"message" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"title" text NOT NULL,
	"kind" text DEFAULT 'manual' NOT NULL,
	"patient_id" uuid,
	"assignee_id" uuid,
	"due_at" date,
	"done_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "treatment_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"appointment_id" uuid,
	"prescription_id" uuid,
	"author_id" uuid NOT NULL,
	"treated_at" timestamp with time zone NOT NULL,
	"findings" text,
	"services_text" text,
	"material" text,
	"sterile_batch_code" text,
	"reaction" text,
	"recommendation" text,
	"foot_points" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"structured" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"missing_photo_reason" text,
	"ai_assisted" boolean DEFAULT false NOT NULL,
	"countersign_required" boolean DEFAULT false NOT NULL,
	"prev_hash" text,
	"hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"password_hash" text NOT NULL,
	"totp_secret_enc" text,
	"totp_enabled" boolean DEFAULT false NOT NULL,
	"is_platform_admin" boolean DEFAULT false NOT NULL,
	"failed_logins" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "vouchers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"code" text NOT NULL,
	"issued_at" date NOT NULL,
	"valid_until" date NOT NULL,
	"amount_cents" integer NOT NULL,
	"purpose" text DEFAULT 'multi' NOT NULL,
	"note" text,
	"sold_invoice_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "waitlist" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"wishes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" "integration_provider" NOT NULL,
	"organization_id" uuid,
	"external_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"error" text
);
--> statement-breakpoint
ALTER TABLE "anamneses" ADD CONSTRAINT "anamneses_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "anamneses" ADD CONSTRAINT "anamneses_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "anamneses" ADD CONSTRAINT "anamneses_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment_services" ADD CONSTRAINT "appointment_services_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment_services" ADD CONSTRAINT "appointment_services_appointment_id_appointments_id_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointment_services" ADD CONSTRAINT "appointment_services_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_therapist_id_users_id_fk" FOREIGN KEY ("therapist_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_contacts" ADD CONSTRAINT "billing_contacts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brace_episodes" ADD CONSTRAINT "brace_episodes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brace_episodes" ADD CONSTRAINT "brace_episodes_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consents" ADD CONSTRAINT "consents_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consents" ADD CONSTRAINT "consents_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consents" ADD CONSTRAINT "consents_recorded_by_users_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixed_costs" ADD CONSTRAINT "fixed_costs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_connections" ADD CONSTRAINT "integration_connections_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_billing_contact_id_billing_contacts_id_fk" FOREIGN KEY ("billing_contact_id") REFERENCES "public"."billing_contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "locations" ADD CONSTRAINT "locations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media" ADD CONSTRAINT "media_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media" ADD CONSTRAINT "media_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media" ADD CONSTRAINT "media_record_id_treatment_records_id_fk" FOREIGN KEY ("record_id") REFERENCES "public"."treatment_records"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media" ADD CONSTRAINT "media_brace_episode_id_brace_episodes_id_fk" FOREIGN KEY ("brace_episode_id") REFERENCES "public"."brace_episodes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media" ADD CONSTRAINT "media_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "number_sequences" ADD CONSTRAINT "number_sequences_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patients" ADD CONSTRAINT "patients_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patients" ADD CONSTRAINT "patients_care_home_id_billing_contacts_id_fk" FOREIGN KEY ("care_home_id") REFERENCES "public"."billing_contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patients" ADD CONSTRAINT "patients_billing_contact_id_billing_contacts_id_fk" FOREIGN KEY ("billing_contact_id") REFERENCES "public"."billing_contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_voucher_id_vouchers_id_fk" FOREIGN KEY ("voucher_id") REFERENCES "public"."vouchers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prescriptions" ADD CONSTRAINT "prescriptions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prescriptions" ADD CONSTRAINT "prescriptions_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "record_addenda" ADD CONSTRAINT "record_addenda_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "record_addenda" ADD CONSTRAINT "record_addenda_record_id_treatment_records_id_fk" FOREIGN KEY ("record_id") REFERENCES "public"."treatment_records"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "record_addenda" ADD CONSTRAINT "record_addenda_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sterile_batches" ADD CONSTRAINT "sterile_batches_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sterile_batches" ADD CONSTRAINT "sterile_batches_released_by_users_id_fk" FOREIGN KEY ("released_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_log" ADD CONSTRAINT "sync_log_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_assignee_id_users_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treatment_records" ADD CONSTRAINT "treatment_records_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treatment_records" ADD CONSTRAINT "treatment_records_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treatment_records" ADD CONSTRAINT "treatment_records_appointment_id_appointments_id_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treatment_records" ADD CONSTRAINT "treatment_records_prescription_id_prescriptions_id_fk" FOREIGN KEY ("prescription_id") REFERENCES "public"."prescriptions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treatment_records" ADD CONSTRAINT "treatment_records_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vouchers" ADD CONSTRAINT "vouchers_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waitlist" ADD CONSTRAINT "waitlist_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waitlist" ADD CONSTRAINT "waitlist_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "appointments_org_time" ON "appointments" USING btree ("organization_id","starts_at");--> statement-breakpoint
CREATE UNIQUE INDEX "appointments_external" ON "appointments" USING btree ("organization_id","source","external_id");--> statement-breakpoint
CREATE INDEX "audit_org_time" ON "audit_log" USING btree ("organization_id","at");--> statement-breakpoint
CREATE UNIQUE INDEX "integration_org_provider" ON "integration_connections" USING btree ("organization_id","provider");--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_org_number" ON "invoices" USING btree ("organization_id","number");--> statement-breakpoint
CREATE INDEX "invoices_org_status" ON "invoices" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "media_patient" ON "media" USING btree ("organization_id","patient_id");--> statement-breakpoint
CREATE UNIQUE INDEX "memberships_org_user" ON "memberships" USING btree ("organization_id","user_id");--> statement-breakpoint
CREATE INDEX "messages_org_time" ON "messages" USING btree ("organization_id","received_at");--> statement-breakpoint
CREATE UNIQUE INDEX "news_items_url" ON "news_items" USING btree ("url");--> statement-breakpoint
CREATE UNIQUE INDEX "number_sequences_key" ON "number_sequences" USING btree ("organization_id","key","year");--> statement-breakpoint
CREATE UNIQUE INDEX "patients_org_number" ON "patients" USING btree ("organization_id","number");--> statement-breakpoint
CREATE INDEX "patients_org_name" ON "patients" USING btree ("organization_id","last_name","first_name");--> statement-breakpoint
CREATE UNIQUE INDEX "services_org_code" ON "services" USING btree ("organization_id","code");--> statement-breakpoint
CREATE INDEX "sessions_user" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sterile_batches_org_code" ON "sterile_batches" USING btree ("organization_id","code");--> statement-breakpoint
CREATE INDEX "treatment_records_patient" ON "treatment_records" USING btree ("organization_id","patient_id","treated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "vouchers_org_code" ON "vouchers" USING btree ("organization_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_events_idem" ON "webhook_events" USING btree ("provider","external_id");