// The daily claim, written once.
//
// Three different ceilings are enforced against the `call_quota` table — the
// free tier, the per-caller served-call bound, the per-caller verify bound, and
// the owner's daily alert budget — and they are all the same question asked
// about different keys: "may I have one more today, and if so how many have I
// had?"
//
// IT IS ONE FUNCTION BECAUSE THE UPSERT IS THE CORRECTNESS. The row is created
// at 1 and incremented only WHILE it is under the ceiling, so the "may I" read
// and the "spend one" write cannot race apart across isolates — which is
// precisely what a read-then-write would do, with a window the size of a D1
// round trip. Written out three times it is three chances to get that wrong,
// and two of them would only be found in production under load.
//
// The KEY carries the namespace: `<ipHash>` is the served-call counter,
// `verify:<ipHash>` the payment-verification counter, `alert:<channel>` the
// owner's notification budget. Distinct keys cannot spend each other's
// allowance, which is what lets one table hold all four.
//
// It lives in its own module rather than in worker.js because the Worker's
// entry module may export nothing but the handler: workerd requires every named
// export of the entry module to be a handler, and a stray one fails the Worker
// at STARTUP with "Incorrect type for map entry".

/**
 * Claim one unit against `key` for `day`, atomically.
 *
 * @returns the count INCLUDING this claim, or null when the ceiling is already
 *   reached — no row comes back when the guard fails, and that absence is the
 *   over-quota signal.
 */
export async function claimQuota(db, day, key, ceiling) {
  const row = await db
    .prepare(
      'INSERT INTO call_quota (day, ip_hash, used) VALUES (?1, ?2, 1) ' +
        'ON CONFLICT(day, ip_hash) DO UPDATE SET used = call_quota.used + 1 ' +
        'WHERE call_quota.used < ?3 ' +
        'RETURNING used'
    )
    .bind(day, key, ceiling)
    .first();
  return typeof row?.used === 'number' ? row.used : null;
}

/** The UTC date the counters are keyed on, YYYY-MM-DD. */
export const utcDay = (nowMs = Date.now()) => new Date(nowMs).toISOString().slice(0, 10);
