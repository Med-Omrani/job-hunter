-- Test: crash recovery. Stamp pending rows as held by a dead worker with an
-- ancient lease, push them to the FRONT of the FIFO queue, then let the API
-- claim. They must be reclaimed.
--
-- Making them oldest matters: the claim endpoint is strictly FIFO by bandAt, so
-- stale rows sitting at rank ~3000 are simply not reached within a limit of 100.
-- That is correct behaviour, not a defect, and this script isolates the lease
-- question from the ordering question.
BEGIN;
WITH victims AS (
  SELECT id FROM offers
   WHERE data->>'band' = 'pending'
   ORDER BY (data->>'bandAt') ASC
   LIMIT 5
)
UPDATE offers o
   SET data = o.data || jsonb_build_object(
         'bandClaimedBy', 'DEAD',
         'bandClaimedAt', '2000-01-01T00:00:00Z',
         'bandAt', '2000-01-01T00:00:00Z')
  FROM victims v
 WHERE o.id = v.id;

SELECT data->>'bandClaimedBy' AS owner, data->>'bandAt' AS band_at, count(*) AS n
  FROM offers WHERE data->>'bandClaimedBy' = 'DEAD' GROUP BY 1,2;
COMMIT;
