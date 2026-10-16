-- Migrate Workday source ids from tenant-only to tenant+site.
--
-- Why: a Workday board's identity is tenant + site. Keying on the tenant alone
-- collapsed distinct boards into one source -- the first discovery run accepted
-- 25 boards but registered only 24 new sources for exactly this reason, and
-- 'workday-ag' (Airbus) collided with the hand-registered 'airbus' source.
--
-- The id is not a foreign key anywhere: offers reference sourceId as text and
-- crawl paths derive from data->>'tenant' + data->>'site', so renaming the id is
-- safe. The old value is kept in data->>'legacySourceId' for traceability.
--
-- Note the parentheses around every data->>'x': without them Postgres parses
-- `->` as a JSON constructor on the concatenated text, not a field lookup.
--
-- Idempotent: only rows whose id is exactly 'workday-' || tenant are touched,
-- and the new id is skipped when it already exists.
BEGIN;

-- Apply. Renaming happens first, then the old id is freed for reuse, and each
-- row records where it came from. A row whose target id already exists is left
-- alone and reported, so re-running this cannot clobber an existing source.
WITH renamed AS (
  UPDATE sources s
     SET id = 'workday-' || (s.data->>'tenant') || '-' ||
               COALESCE(NULLIF(regexp_replace(lower(COALESCE((s.data->>'site'),'')), '[^a-z0-9]+', '-', 'g'), ''), 'site'),
         data = s.data || jsonb_build_object('legacySourceId', s.id)
   WHERE (s.data->>'type') = 'workday'
     AND s.id = 'workday-' || (s.data->>'tenant')
     AND COALESCE((s.data->>'site'), '') <> ''
     AND NOT EXISTS (
       SELECT 1 FROM sources x
        WHERE x.id = 'workday-' || (s.data->>'tenant') || '-' ||
              COALESCE(NULLIF(regexp_replace(lower(COALESCE((s.data->>'site'),'')), '[^a-z0-9]+', '-', 'g'), ''), 'site')
     )
  RETURNING s.id AS new_id, s.data->>'legacySourceId' AS old_id
)
SELECT count(*) AS renamed FROM renamed;

-- Anything skipped because the target id was already taken.
SELECT s.id AS kept_tenant_only_id, (s.data->>'site') AS site
  FROM sources s
 WHERE (s.data->>'type') = 'workday'
   AND s.id = 'workday-' || (s.data->>'tenant')
   AND COALESCE((s.data->>'site'), '') <> '';

COMMIT;

COMMIT;

-- Verify: no tenant-only Workday ids should remain. (Run outside the
-- transaction; kept as a commented example because `||` at statement level needs
-- the same parenthesised (->) casts.)
--
--   SELECT id FROM sources
--    WHERE (data->>'type') = 'workday'
--      AND id = 'workday-' || (data->>'tenant');

