-- Noir Rush leaderboard: one row per player with their best run.
CREATE TABLE IF NOT EXISTS scores (
  player  TEXT PRIMARY KEY,           -- random id kept in the player's browser
  name    TEXT NOT NULL,
  score   INTEGER NOT NULL,
  level   INTEGER NOT NULL,
  dist    INTEGER NOT NULL,
  hats    INTEGER NOT NULL,
  updated INTEGER NOT NULL            -- unix ms
);
CREATE INDEX IF NOT EXISTS scores_rank ON scores (score DESC, updated ASC);

-- Run tickets: issued when a run starts, spent when its score is submitted.
CREATE TABLE IF NOT EXISTS runs (
  id      TEXT PRIMARY KEY,
  player  TEXT NOT NULL,
  started INTEGER NOT NULL,           -- unix ms, server clock
  used    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS runs_started ON runs (started);
