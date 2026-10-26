-- Up Migration
-- دفتر الأستاذ بقيد مزدوج لا يُعدَّل (ADR 0031، ADR 0025 الجزء 7؛ بأمر المنسّق). ثوابته في القاعدة لا في الكود وحده:
-- التوازن لكل عملة عند الإيداع، والعملة الواحدة بين السطر وحسابه، ولا تحديث ولا حذف حتى لمالك الجدول، والتصحيح بقيد
-- عكسي. الرصيد لا يُخزَّن، والصرف فوق الرصيد يفحصه الخادم بقفل صف الحساب.

CREATE TABLE ledger_accounts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind          text NOT NULL,
  owner_id      uuid REFERENCES users(id),
  payable_state text,
  currency      text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ledger_accounts_kind_check CHECK (kind IN ('provider_clearing', 'provider_fees', 'taxes', 'platform_revenue',
                                                        'contributor_payable', 'refund_reserve')),
  CONSTRAINT ledger_accounts_payable_state_check
    CHECK (payable_state IS NULL OR payable_state IN ('pending', 'available', 'in_payout', 'paid')),
  CONSTRAINT ledger_accounts_currency_check CHECK (currency IN ('USD', 'ILS')),
  -- المستحق للمساهم وحده له مالك وحالة، ولكل حالة حساب
  CONSTRAINT ledger_accounts_contributor_check CHECK (
    (kind = 'contributor_payable') = (owner_id IS NOT NULL) AND
    (kind = 'contributor_payable') = (payable_state IS NOT NULL))
);
CREATE UNIQUE INDEX ledger_accounts_key ON ledger_accounts (kind, owner_id, payable_state, currency) NULLS NOT DISTINCT;

-- تفاصيل القيد (قاعدة العمولة المجمّدة) أرقام ومعرّفات فقط: لا نص حر، ولا أسماء، ولا عناوين.
-- النص المقبول معرّف uuid، أو رمز بحروف صغيرة وشرطة سفلية، أو رمز عملة.
CREATE FUNCTION ledger_details_is_plain(value jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path = public, pg_temp AS $$
BEGIN
  CASE jsonb_typeof(value)
    WHEN 'object' THEN
      RETURN NOT EXISTS (SELECT 1 FROM jsonb_each(value) e
                          WHERE e.key !~ '^[a-z_]{1,32}$' OR NOT public.ledger_details_is_plain(e.value));
    WHEN 'array' THEN
      RETURN NOT EXISTS (SELECT 1 FROM jsonb_array_elements(value) a WHERE NOT public.ledger_details_is_plain(a));
    WHEN 'string' THEN
      RETURN (value #>> '{}') ~ '^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[a-z_]{1,32}|[A-Z]{3})$';
    ELSE
      RETURN true;
  END CASE;
END $$;

CREATE TABLE journal_entries (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind              text NOT NULL,
  reference_type    text NOT NULL,
  reference_id      uuid NOT NULL,
  details           jsonb NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key   text NOT NULL,
  reverses_entry_id uuid REFERENCES journal_entries(id),
  occurred_at       timestamptz NOT NULL DEFAULT now(),
  actor_id          uuid REFERENCES users(id),
  CONSTRAINT journal_entries_kind_check CHECK (kind IN ('sale', 'refund', 'release', 'payout', 'correction')),
  CONSTRAINT journal_entries_reference_type_check CHECK (reference_type ~ '^[a-z_]{1,32}$'),
  CONSTRAINT journal_entries_idempotency_key_check CHECK (char_length(idempotency_key) BETWEEN 1 AND 200),
  CONSTRAINT journal_entries_idempotency_key_key UNIQUE (idempotency_key),
  -- العكس للاسترداد والتصحيح وحدهما
  CONSTRAINT journal_entries_reverses_check CHECK ((kind IN ('refund', 'correction')) = (reverses_entry_id IS NOT NULL)),
  CONSTRAINT journal_entries_details_check CHECK (jsonb_typeof(details) = 'object' AND public.ledger_details_is_plain(details))
);
-- التصحيح يعكس القيد كاملًا مرة واحدة؛ الاسترداد قد يتعدد بنسبته
CREATE UNIQUE INDEX journal_entries_correction_key ON journal_entries (reverses_entry_id) WHERE kind = 'correction';
CREATE INDEX journal_entries_reference_idx ON journal_entries (reference_type, reference_id);

CREATE TABLE postings (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  entry_id     uuid NOT NULL REFERENCES journal_entries(id),
  account_id   uuid NOT NULL REFERENCES ledger_accounts(id),
  amount_minor bigint NOT NULL,
  currency     text NOT NULL,
  CONSTRAINT postings_amount_check CHECK (amount_minor <> 0),
  CONSTRAINT postings_currency_check CHECK (currency IN ('USD', 'ILS'))
);
CREATE INDEX postings_account_idx ON postings (account_id);
CREATE INDEX postings_entry_idx ON postings (entry_id);

-- (ب) عملة السطر عملة حسابه
CREATE FUNCTION posting_currency_matches() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.ledger_accounts a WHERE a.id = NEW.account_id AND a.currency = NEW.currency) THEN
    RAISE EXCEPTION 'a posting must be in its account currency' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER postings_currency_matches BEFORE INSERT ON postings
  FOR EACH ROW EXECUTE FUNCTION posting_currency_matches();

-- (أ) القيد سطران فأكثر ومجموعه صفر لكل عملة، يُفحص عند الإيداع؛ وقيد بلا سطور يُفحص كذلك
CREATE FUNCTION journal_entry_balanced() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  entry uuid;
BEGIN
  IF TG_TABLE_NAME = 'postings' THEN
    entry := NEW.entry_id;
  ELSE
    entry := NEW.id;
  END IF;
  IF (SELECT count(*) FROM public.postings p WHERE p.entry_id = entry) < 2 THEN
    RAISE EXCEPTION 'a journal entry needs at least two postings' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM public.postings p WHERE p.entry_id = entry GROUP BY p.currency HAVING sum(p.amount_minor) <> 0) THEN
    RAISE EXCEPTION 'a journal entry must balance in each currency' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER postings_balanced AFTER INSERT ON postings
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION journal_entry_balanced();
CREATE CONSTRAINT TRIGGER journal_entries_balanced AFTER INSERT ON journal_entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION journal_entry_balanced();

-- (ج) لا تحديث ولا حذف للقيود وسطورها حتى للمالك، كما في audit_log؛ وسحب الصلاحيتين من دور التطبيق
CREATE FUNCTION ledger_append_only() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
END $$;
CREATE TRIGGER journal_entries_append_only BEFORE UPDATE OR DELETE ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION ledger_append_only();
CREATE TRIGGER journal_entries_no_truncate BEFORE TRUNCATE ON journal_entries
  FOR EACH STATEMENT EXECUTE FUNCTION ledger_append_only();
CREATE TRIGGER postings_append_only BEFORE UPDATE OR DELETE ON postings
  FOR EACH ROW EXECUTE FUNCTION ledger_append_only();
CREATE TRIGGER postings_no_truncate BEFORE TRUNCATE ON postings
  FOR EACH STATEMENT EXECUTE FUNCTION ledger_append_only();
REVOKE UPDATE, DELETE, TRUNCATE ON journal_entries, postings FROM PUBLIC, CURRENT_USER;

-- هوية الحساب (النوع والمالك والحالة والعملة) لا تتغير
CREATE FUNCTION ledger_account_identity_fixed() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF (NEW.kind, NEW.owner_id, NEW.payable_state, NEW.currency) IS DISTINCT FROM
     (OLD.kind, OLD.owner_id, OLD.payable_state, OLD.currency) THEN
    RAISE EXCEPTION 'a ledger account keeps its kind, owner, state and currency' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ledger_accounts_identity_fixed BEFORE UPDATE ON ledger_accounts
  FOR EACH ROW EXECUTE FUNCTION ledger_account_identity_fixed();

-- Down Migration

DROP TABLE postings;
DROP TABLE journal_entries;
DROP TABLE ledger_accounts;
DROP FUNCTION ledger_account_identity_fixed();
DROP FUNCTION ledger_append_only();
DROP FUNCTION journal_entry_balanced();
DROP FUNCTION posting_currency_matches();
DROP FUNCTION ledger_details_is_plain(jsonb);
