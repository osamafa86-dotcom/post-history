-- Up Migration
-- دفاع في القاعدة ضد التعديل اليدوي (طلب المنسّق، #58): لا يقل عدد مديري النظام الفاعلين عن اثنين بأي تعديل يُنقص منهم.
-- الفاعل = دور system_admin على حساب حالته active. لا يمنع الإنشاء الأول (نظام بمدير واحد أو بلا مدير)، ويفحص في نهاية
-- المعاملة فيسمح بتبديل مدير بآخر داخل معاملة واحدة.

CREATE FUNCTION active_system_admin_count() RETURNS bigint
LANGUAGE sql STABLE AS $$
  SELECT count(DISTINCT r.user_id)
  FROM user_roles r JOIN users u ON u.id = r.user_id
  WHERE r.role = 'system_admin' AND u.status = 'active'
$$;

CREATE FUNCTION admin_quorum_check() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  lost boolean := false;
BEGIN
  IF TG_TABLE_NAME = 'user_roles' THEN
    -- من صف OLD وحده: الفحص مؤجل إلى نهاية المعاملة، فالاعتماد على حالة المستخدم الآن يسمح بتعليقه ثم حذف دوره في
    -- معاملة واحدة، وحذف المستخدم يحذف دوره بـ CASCADE قبل التقييم (مراجعة الأمن على #58). حذف دور مدير معلَّق حين
    -- يكون عدد الفاعلين أقل من اثنين يُرفض أيضًا؛ ثمن مقبول لدفاع لا ثغرة فيه.
    lost := OLD.role = 'system_admin'
            AND (TG_OP = 'DELETE' OR NEW.role <> 'system_admin' OR NEW.user_id <> OLD.user_id);
  ELSE
    lost := OLD.status = 'active'
            AND (TG_OP = 'DELETE' OR NEW.status <> 'active')
            AND EXISTS (SELECT 1 FROM user_roles WHERE user_id = OLD.id AND role = 'system_admin');
  END IF;
  IF lost AND active_system_admin_count() < 2 THEN
    RAISE EXCEPTION 'at least two active system administrators are required'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'admin_quorum_min_two';
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER admin_quorum_user_roles
  AFTER UPDATE OR DELETE ON user_roles DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION admin_quorum_check();
CREATE CONSTRAINT TRIGGER admin_quorum_users
  AFTER UPDATE OF status OR DELETE ON users DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION admin_quorum_check();

-- Down Migration
DROP TRIGGER admin_quorum_users ON users;
DROP TRIGGER admin_quorum_user_roles ON user_roles;
DROP FUNCTION admin_quorum_check();
DROP FUNCTION active_system_admin_count();
