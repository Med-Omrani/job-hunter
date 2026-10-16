'use strict';
const { Pool } = require('pg');
const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL required');
const pool = new Pool({ connectionString: url });
async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS offers (
      id TEXT PRIMARY KEY,
      data JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      score INT,
      match BOOLEAN,
      status TEXT
    );
    CREATE TABLE IF NOT EXISTS docs (
      id TEXT PRIMARY KEY,
      data JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      offer_ref TEXT,
      pdf_path TEXT
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      data JSONB NOT NULL,
      status TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS sources (
      id TEXT PRIMARY KEY,
      data JSONB NOT NULL,
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS chat_messages (
      id TEXT PRIMARY KEY,
      text TEXT NOT NULL,
      sender TEXT NOT NULL,
      channel TEXT NOT NULL DEFAULT 'main',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS channel TEXT NOT NULL DEFAULT 'main';
    ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS reply_to TEXT;
    CREATE TABLE IF NOT EXISTS agent_status (
      id TEXT PRIMARY KEY,
      data JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS profile (
      id TEXT PRIMARY KEY,
      data JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS devices (
      id TEXT PRIMARY KEY,
      token TEXT NOT NULL,
      platform TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_offers_updated ON offers(updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_offers_match ON offers(match);
    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
    CREATE INDEX IF NOT EXISTS idx_chat_created ON chat_messages(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_chat_channel_created ON chat_messages(channel, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_sources_enabled ON sources(enabled);
  `);

  // ---- search indexes (added 2026-09-25) --------------------------------
  // The offer list is JSONB, so free-text search needs a trigram index over
  // the concatenated searchable fields, and the filter facets need expression
  // btrees. Done in a second pass because CREATE EXTENSION cannot run inside
  // the same multi-statement batch on all Postgres versions.
  await pool.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_offers_status ON offers(status, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_offers_country ON offers(lower(COALESCE(data->>'country','')));
    CREATE INDEX IF NOT EXISTS idx_offers_source ON offers(lower(COALESCE(data->>'sourceId', data->>'source','')));
    CREATE INDEX IF NOT EXISTS idx_offers_score ON offers(score DESC NULLS LAST);
  `);
  // Partial btree over the "seen" marker, so the Vu tab can sort by when the
  // user actually opened an offer. Partial because only opened rows carry the
  // key, which keeps the index tiny (0 rows today, grows one per open).
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_offers_seen ON offers((data->>'seenAt') DESC)
      WHERE data ? 'seenAt';
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_offers_search ON offers USING gin (
      (lower(
        COALESCE(data->>'title','') || ' ' ||
        COALESCE(data->>'company','') || ' ' ||
        COALESCE(data->>'ref','') || ' ' ||
        COALESCE(data->>'location','') || ' ' ||
        COALESCE(data->>'contract','') || ' ' ||
        COALESCE(data->>'description','')
      )) gin_trgm_ops
    );
  `);
  // ---- relevance band + behavioural feedback (added 2026-10-04) ----------
  //
  // The keyword engine drops ~70% of scraped postings. A slice of those are
  // real misses (Valeo's "Technicien Maintenance" was rejected as non-engineering
  // by keywords AND by the first classifier prompt). The band stores those
  // rejected-but-classifiable offers so a semantic second opinion can rescue
  // them, instead of them being discarded forever at the insert gate.
  //
  // Stored inside `offers` with data->>'band' = 'pending' rather than in a side
  // table so the existing dedupe in insert-new still protects them, and so a
  // promotion is a single UPDATE (match/score flip) with no join.
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_offers_band_pending ON offers(updated_at)
      WHERE data->>'band' = 'pending';
    CREATE INDEX IF NOT EXISTS idx_offers_band_promoted ON offers(updated_at DESC)
      WHERE data->>'band' = 'promoted';
  `);
  //
  // offer_events: what the user actually DID with an offer. This is the raw
  // signal for relevance feedback; the weights are applied by the worker, not
  // baked into the schema.
  //
  // Note on honesty: with a single user and a handful of applications this table
  // supports EXPLAINABLE adjustments, not learning. Every derived adjustment is
  // logged with its reason so a bad signal stays visible instead of silently
  // steering the feed.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS offer_events (
      id BIGSERIAL PRIMARY KEY,
      offer_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      weight INT NOT NULL DEFAULT 0,
      meta JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_offer_events_offer ON offer_events(offer_id);
    CREATE INDEX IF NOT EXISTS idx_offer_events_kind ON offer_events(kind, created_at DESC);
  `);

  // ensure profile/me exists
  const r = await pool.query('SELECT id FROM profile WHERE id=$1', ['me']);
  if (!r.rows.length) {
    await pool.query("INSERT INTO profile(id,data) VALUES('me','{\"name\":\"Mohamed Omrani\"}'::jsonb) ON CONFLICT DO NOTHING");
  }
  // ensure agent_status row
  await pool.query("INSERT INTO agent_status(id,data) VALUES('agent','{\"online\":true}'::jsonb) ON CONFLICT DO NOTHING");
}
module.exports = { pool, init };
