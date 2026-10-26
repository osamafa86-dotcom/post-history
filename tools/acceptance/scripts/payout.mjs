import { runDelegated } from "../lib/delegate.mjs";

// «صرف المستحقات»: الطلبات المتزامنة وقيد الصرف والاسترداد بعده بالقناة التجريبية (لا مال حقيقي ولا قناة صرف حقيقية بعد).
export const run = () => runDelegated("payout", ["payout-concurrent", "refund-after-payout"]);
