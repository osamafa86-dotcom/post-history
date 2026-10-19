import { customType } from 'drizzle-orm/pg-core';

// drizzle-kit pull لا يتعرف على bytea؛ scripts/db-pull.sh يستبدل به هذا النوع بعد الاستبطان.
export const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
});
