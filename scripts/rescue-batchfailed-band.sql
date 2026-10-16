-- Return offers that were rejected because of a PROVIDER failure rather than a
-- real verdict, so the classifier can judge them properly once quota returns.
--
-- Context: an earlier worker version recorded a false verdict on batch failure,
-- which set band='rejected' with reason='batch_failed'. Those rows were never
-- assessed by the model; they are simply unprocessed. Leaving them rejected
-- would hide genuine matches permanently, because nothing ever revisits a
-- rejected row.
--
-- Scope is deliberately narrow: only rows whose reason is exactly 'batch_failed'
-- (or an explicitly provider-shaped reason). Real rejections keep their verdict.
BEGIN;

WITH rescued AS (
  UPDATE offers
     SET match = false,
         score = 0,
         data = (data - 'bandVerdict') || jsonb_build_object(
           'band', 'pending',
           'bandTries', '0',
           'bandAt', to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
           'bandExpiresAt', to_char(NOW() AT TIME ZONE 'UTC' + interval '21 days', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
           'bandRescuedFrom', 'batch_failed'
         )
   WHERE data->>'band' = 'rejected'
     AND data->'bandVerdict'->>'reason' IN ('batch_failed', 'unparseable:no_verdicts_array', 'unparseable:missing_ids')
  RETURNING id, data->>'title' AS title
)
SELECT count(*) AS rescued,
       count(*) FILTER (WHERE title ~* 'engineer|developer|technician|supervisor|maintenance|quality|embedded') AS looks_relevant
  FROM rescued;
COMMIT;
