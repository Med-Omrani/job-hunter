-- Isolate the claim predicate. Prints, for pending rows, exactly which of the
-- three WHERE conditions passes, so a stale lease that is never reclaimed can be
-- traced to the clause that rejected it rather than guessed at.
SELECT
  data->>'bandClaimedBy'                        AS owner,
  data->>'bandClaimedAt'                        AS claimed_at,
  (data->>'bandExpiresAt')::timestamptz > NOW() AS not_expired,
  COALESCE((data->>'bandClaimedAt')::timestamptz, to_timestamp(0))
      < NOW() - interval '600 seconds'          AS lease_free,
  data->>'bandAt'                               AS band_at
  FROM offers
 WHERE data->>'band' = 'pending'
   AND (data->>'bandClaimedBy' IS NOT NULL OR data->>'bandClaimedBy' = 'TZ')
 ORDER BY (data->>'bandAt') ASC
 LIMIT 12;
