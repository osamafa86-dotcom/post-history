// The contributor (the reporter whose materials are sold) of every live script that sells. A paid sale credits that reporter's
// pending balance, and the payout worker releases it to «available» a moment later, asynchronously. A script that judges a
// reporter's balance to the unit (payout-concurrent, refund-after-payout) is therefore only sound while no other script sells
// that reporter's materials: each selling script has its own seeded reporter (live/seed.mjs creates them, live/run.mjs hands
// each script its own token). `reporter` stays sandbox-purchase's, the only selling script that used it before.
export const CONTRIBUTORS = Object.freeze({
  "sandbox-purchase": "reporter",
  "tenant-isolation": "contributor_tenant",
  "duplicate-payment": "contributor_dp",
  "rights-exclusivity": "contributor_rx",
  "payout-concurrent": "contributor_payout",
  "refund-after-payout": "contributor_refund",
});

/** The seeded accounts to create for them (everything but the shared `reporter`). */
export const DEDICATED_CONTRIBUTORS = Object.freeze([...new Set(Object.values(CONTRIBUTORS))].filter((k) => k !== "reporter"));
