-- Idempotent – darf erneut laufen (korrigiert nur abweichende Werte, Index nur falls nicht vorhanden).
--
-- 1) Altdaten-Korrektur paid_cents/status: Der SumUp-Webhook hat paid_cents früher aus der Summe der Zahlungszeilen
--    neu berechnet. Angerechnete Anzahlungen/Quittungen (collective_invoice_id) haben keine Zahlungszeile und gingen
--    dabei verloren. Betroffen: Rechnung/Sammelrechnung aus PodoHero (source = 'crm'), ausgestellt (nicht Entwurf/
--    Storno), mit mindestens einer SumUp-Zahlung. Soll = Σ angerechnete Belege + Σ Zahlungen; Status wie
--    statusFromPayments (src/lib/invoice-math.ts). Je geänderter Rechnung ein Audit-Eintrag (alter/neuer Wert,
--    bei Überzahlung zusätzlich overpaid: true). Stornierte Teilbelege zählen nicht.
--    RLS ist auch für den Eigentümer erzwungen → je Praxis app.org_id setzen.
-- 2) Eindeutiger Index je SumUp-Transaktion (payments.external_ref 'sumup:%') – nur, wenn keine Dubletten vorhanden
--    sind (sonst NOTICE und kein Index; Dubletten bitte fachlich klären, Zahlungen sind unveränderbar).
DO $$
DECLARE
  o record;
  r record;
  soll integer;
  neu_status invoice_status;
  dubletten integer := 0;
BEGIN
  FOR o IN SELECT id FROM organizations LOOP
    PERFORM set_config('app.org_id', o.id::text, true);
    FOR r IN
      SELECT i.id, i.number, i.total_cents, i.paid_cents, i.status,
             (SELECT coalesce(sum(d.total_cents), 0) FROM invoices d
               WHERE d.organization_id = i.organization_id AND d.collective_invoice_id = i.id AND d.kind IN ('deposit', 'receipt')
                 AND d.status <> 'cancelled')
           + (SELECT coalesce(sum(p.amount_cents), 0) FROM payments p
               WHERE p.organization_id = i.organization_id AND p.invoice_id = i.id) AS soll
      FROM invoices i
      WHERE i.organization_id = o.id
        AND i.kind IN ('invoice', 'collective')
        AND i.source = 'crm'
        AND i.status NOT IN ('draft', 'cancelled')
        AND EXISTS (SELECT 1 FROM payments p WHERE p.organization_id = i.organization_id AND p.invoice_id = i.id AND p.external_ref LIKE 'sumup:%')
      FOR UPDATE OF i
    LOOP
      soll := r.soll;
      neu_status := CASE
        WHEN r.total_cents = 0 THEN 'paid'
        WHEN soll * sign(r.total_cents) >= r.total_cents * sign(r.total_cents) THEN 'paid'
        WHEN soll * sign(r.total_cents) > 0 THEN 'partially_paid'
        ELSE 'issued'
      END;
      IF r.paid_cents IS DISTINCT FROM soll OR r.status IS DISTINCT FROM neu_status THEN
        UPDATE invoices SET paid_cents = soll, status = neu_status WHERE organization_id = o.id AND id = r.id;
        INSERT INTO audit_log (organization_id, user_id, action, entity, entity_id, meta)
        VALUES (o.id, NULL, 'invoice.paid_correction', 'invoice', r.id::text,
                jsonb_build_object('number', r.number, 'migration', '0048_sumup_zahlungen_korrektur',
                                   'old', jsonb_build_object('paidCents', r.paid_cents, 'status', r.status),
                                   'new', jsonb_build_object('paidCents', soll, 'status', neu_status))
                || CASE WHEN r.total_cents <> 0 AND soll * sign(r.total_cents) > r.total_cents * sign(r.total_cents)
                        THEN jsonb_build_object('overpaid', true) ELSE '{}'::jsonb END);
      END IF;
    END LOOP;
    dubletten := dubletten + (
      SELECT count(*) FROM (
        SELECT 1 FROM payments WHERE organization_id = o.id AND external_ref LIKE 'sumup:%'
        GROUP BY external_ref HAVING count(*) > 1
      ) x);
  END LOOP;
  PERFORM set_config('app.org_id', '', true);

  IF dubletten > 0 THEN
    RAISE NOTICE 'payments_org_sumup_ref nicht angelegt: % doppelte SumUp-Referenz(en) – bitte prüfen.', dubletten;
  ELSE
    EXECUTE 'CREATE UNIQUE INDEX IF NOT EXISTS "payments_org_sumup_ref" ON "payments" USING btree ("organization_id","external_ref") WHERE "payments"."external_ref" like ''sumup:%''';
  END IF;
END $$;
