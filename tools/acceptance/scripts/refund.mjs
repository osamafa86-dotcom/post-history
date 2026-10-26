import { runDelegated } from "../lib/delegate.mjs";

// «الاسترداد»: القيد العكسي قبل الصرف (في sandbox-purchase) وبعده (refund-after-payout)، يشغَّلان معًا بـ live/run.mjs.
export const run = () => runDelegated("refund", ["sandbox-purchase", "refund-after-payout"]);
