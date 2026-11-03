-- Up Migration
-- أرقام الطلب المقروءة (ADR 0100): رقم طلب عشوائي يُعطى عند الإنشاء، ورقم أمر شراء اختياري يكتبه المشتري مع الطلب، ورقم
-- فاتورة متسلسل بلا فجوات لكل سنة يُعطى في معاملة تأكيد الدفع نفسها. الضريبة والمجموع الفرعي وبيانات المُصدِر وملف PDF
-- للفاتورة خارج هذا الترحيل (مؤجَّلة في ADR 0100).

-- رقم الطلب: ORD-<سنة الإنشاء>-<ثمانية من أبجدية Crockford بلا I وL وO وU>، عشوائي لا متسلسل: المشتري يرى أرقام طلباته،
-- والمتسلسل يكشف له عدد طلبات المتجر بين طلبين. البايتات من gen_random_uuid (المولّد القوي في Postgres)، والسحب يُعاد إن
-- سبق الرقم، والفهرس الفريد يحسم السباق النادر. مثبّتة بـ search_path (#71).
CREATE FUNCTION order_number_new(created timestamptz) RETURNS text
LANGUAGE plpgsql VOLATILE
SET search_path = public, pg_temp
AS $$
DECLARE
  alphabet constant text := '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  -- بايتات UUID v4 العشوائية كاملةً: نصف السابع إصدار ونصف التاسع نوع، فلا يُؤخذان
  positions constant integer[] := ARRAY[0, 1, 2, 3, 4, 5, 7, 9];
  raw bytea;
  pos integer;
  candidate text;
BEGIN
  LOOP
    raw := decode(replace(gen_random_uuid()::text, '-', ''), 'hex');
    candidate := 'ORD-' || to_char(created AT TIME ZONE 'UTC', 'YYYY') || '-';
    FOREACH pos IN ARRAY positions LOOP
      candidate := candidate || substr(alphabet, get_byte(raw, pos) % 32 + 1, 1);
    END LOOP;
    EXIT WHEN NOT EXISTS (SELECT 1 FROM public.orders WHERE order_number = candidate);
  END LOOP;
  RETURN candidate;
END $$;

ALTER TABLE orders
  ADD COLUMN order_number text,
  ADD COLUMN purchase_order_number text,
  ADD COLUMN invoice_number text;

-- عدّاد الفاتورة لكل سنة: صف يُقفل ويرتفع واحدًا في معاملة الدفع، فالتراجع يعيده ولا فجوة. لا يُنقص ولا يُحذف.
CREATE TABLE invoice_counters (
  invoice_year integer PRIMARY KEY,
  last_value   integer NOT NULL,
  CONSTRAINT invoice_counters_year_check CHECK (invoice_year BETWEEN 2000 AND 9999),
  CONSTRAINT invoice_counters_value_check CHECK (last_value >= 1)
);

-- الطلبات القائمة: رقم لكل طلب، وفاتورة لكل طلب دُفع بترتيب دفعه في سنته، بلا لمس updated_at
ALTER TABLE orders DISABLE TRIGGER orders_set_updated_at;
UPDATE orders SET order_number = public.order_number_new(created_at);
WITH numbered AS (
  SELECT id, extract(year FROM paid_at AT TIME ZONE 'UTC')::integer AS y,
         row_number() OVER (PARTITION BY extract(year FROM paid_at AT TIME ZONE 'UTC') ORDER BY paid_at, id)::integer AS n
    FROM orders WHERE paid_at IS NOT NULL
)
UPDATE orders o SET invoice_number = 'INV-' || numbered.y::text || '-' || lpad(numbered.n::text, greatest(6, length(numbered.n::text)), '0')
  FROM numbered WHERE o.id = numbered.id;
INSERT INTO invoice_counters (invoice_year, last_value)
  SELECT extract(year FROM paid_at AT TIME ZONE 'UTC')::integer, count(*)::integer
    FROM orders WHERE paid_at IS NOT NULL GROUP BY 1;
ALTER TABLE orders ENABLE TRIGGER orders_set_updated_at;

ALTER TABLE orders
  ALTER COLUMN order_number SET NOT NULL,
  ALTER COLUMN order_number SET DEFAULT public.order_number_new(now()),
  ADD CONSTRAINT orders_order_number_check CHECK (order_number ~ '^ORD-[0-9]{4}-[0-9A-HJKMNP-TV-Z]{8}$'),
  -- رقم أمر الشراء بمرجع المشتري: 1–64 محرفًا لاتينيًا أو رقمًا أو « ._/#-»، يبدأ وينتهي بحرف أو رقم. لا محارف تحكم ولا اتجاه
  ADD CONSTRAINT orders_purchase_order_number_check CHECK (
    purchase_order_number IS NULL OR purchase_order_number ~ '^[A-Za-z0-9](?:[A-Za-z0-9 ._/#-]{0,62}[A-Za-z0-9])?$'),
  -- الفاتورة للطلب المدفوع وحده، ومعه منذ لحظة الدفع (والمسترد يحتفظ بها)
  ADD CONSTRAINT orders_invoice_number_check CHECK (
    (paid_at IS NULL) = (invoice_number IS NULL) AND
    (invoice_number IS NULL OR invoice_number ~ '^INV-[0-9]{4}-[0-9]{6,}$'));
CREATE UNIQUE INDEX orders_order_number_key ON orders (order_number);
CREATE UNIQUE INDEX orders_invoice_number_key ON orders (invoice_number) WHERE invoice_number IS NOT NULL;

-- الأرقام الثلاثة لا تتغيّر بعد إعطائها، ورقم الفاتورة من هنا وحده لحظة ضبط paid_at (لا يكتبه الخادم ولا غيره)
CREATE FUNCTION orders_numbers() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  y integer;
  n integer;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF (NEW.order_number, NEW.purchase_order_number) IS DISTINCT FROM (OLD.order_number, OLD.purchase_order_number) THEN
      RAISE EXCEPTION 'an order keeps its order number and purchase order number' USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.invoice_number IS NOT NULL THEN
      IF NEW.invoice_number IS DISTINCT FROM OLD.invoice_number THEN
        RAISE EXCEPTION 'an invoice number never changes' USING ERRCODE = 'check_violation';
      END IF;
      RETURN NEW;
    END IF;
  END IF;
  IF NEW.invoice_number IS NOT NULL THEN
    RAISE EXCEPTION 'an invoice number is given at payment confirmation alone' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.paid_at IS NOT NULL THEN
    y := extract(year FROM NEW.paid_at AT TIME ZONE 'UTC')::integer;
    INSERT INTO public.invoice_counters AS c (invoice_year, last_value) VALUES (y, 1)
      ON CONFLICT (invoice_year) DO UPDATE SET last_value = c.last_value + 1
      RETURNING c.last_value INTO n;
    NEW.invoice_number := 'INV-' || y::text || '-' || lpad(n::text, greatest(6, length(n::text)), '0');
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER orders_numbers BEFORE INSERT OR UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION orders_numbers();

CREATE FUNCTION invoice_counters_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'invoice counters are never deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.invoice_year <> OLD.invoice_year OR NEW.last_value <> OLD.last_value + 1 THEN
    RAISE EXCEPTION 'an invoice counter only moves up by one' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER invoice_counters_guard BEFORE UPDATE OR DELETE ON invoice_counters
  FOR EACH ROW EXECUTE FUNCTION invoice_counters_guard();

-- Down Migration

DROP TRIGGER orders_numbers ON orders;
DROP FUNCTION orders_numbers();
DROP TABLE invoice_counters;
DROP FUNCTION invoice_counters_guard();
ALTER TABLE orders
  DROP COLUMN invoice_number,
  DROP COLUMN purchase_order_number,
  DROP COLUMN order_number;
DROP FUNCTION order_number_new(timestamptz);
