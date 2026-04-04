-- PickMates schema — multi-game version
-- All migrations are idempotent (safe to re-run on existing databases)

-- ── Users ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id             SERIAL PRIMARY KEY,
  username       VARCHAR(50) UNIQUE NOT NULL,
  password_hash  TEXT NOT NULL,
  is_admin       BOOLEAN DEFAULT FALSE,
  created_at     TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Legacy column kept for rollback safety — no longer written to for new games
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name='users' AND column_name='draft_position') THEN
    ALTER TABLE users ADD COLUMN draft_position INTEGER;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name='users' AND column_name='is_admin') THEN
    ALTER TABLE users ADD COLUMN is_admin BOOLEAN DEFAULT FALSE;
  END IF;
END $$;

-- ── Games (replaces draft_state) ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS games (
  id                  SERIAL PRIMARY KEY,
  name                VARCHAR(200) NOT NULL,
  tournament_id       VARCHAR(20),
  tournament_name     VARCHAR(200),
  current_pick_index  INTEGER DEFAULT 0,
  is_started          BOOLEAN DEFAULT FALSE,
  is_complete         BOOLEAN DEFAULT FALSE,
  started_at          TIMESTAMP WITH TIME ZONE,
  created_at          TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Migrate existing draft_state row → games (only if games is empty)
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='draft_state')
     AND NOT EXISTS (SELECT 1 FROM games) THEN
    INSERT INTO games (id, name, tournament_id, tournament_name, current_pick_index, is_started, is_complete, started_at)
    SELECT 1,
           COALESCE(tournament_name, 'Game 1'),
           tournament_id,
           tournament_name,
           current_pick_index,
           COALESCE(is_started, FALSE),
           COALESCE(is_complete, FALSE),
           started_at
    FROM draft_state WHERE id = 1;
    -- Reset the sequence so the next game gets id=2
    PERFORM setval('games_id_seq', (SELECT MAX(id) FROM games));
  END IF;
END $$;

-- ── Game participants (replaces users.draft_position) ─────────────────────────
CREATE TABLE IF NOT EXISTS game_participants (
  id              SERIAL PRIMARY KEY,
  game_id         INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  draft_position  INTEGER,
  UNIQUE(game_id, user_id),
  UNIQUE(game_id, draft_position)
);

-- Migrate existing users.draft_position → game_participants for game 1
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM games WHERE id = 1)
     AND NOT EXISTS (SELECT 1 FROM game_participants WHERE game_id = 1) THEN
    INSERT INTO game_participants (game_id, user_id, draft_position)
    SELECT 1, id, draft_position
    FROM users
    WHERE draft_position IS NOT NULL;
  END IF;
END $$;

-- ── Picks ─────────────────────────────────────────────────────────────────────
DO $$ BEGIN
  -- Drop old pick_slot CHECK constraint if it restricts to 6 (now variable)
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name='picks' AND column_name='pick_slot') THEN
    -- Table exists in v2 format, just add game_id if missing
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name='picks' AND column_name='game_id') THEN
      ALTER TABLE picks ADD COLUMN game_id INTEGER REFERENCES games(id) ON DELETE CASCADE;
      UPDATE picks SET game_id = 1 WHERE game_id IS NULL;
    END IF;
  ELSE
    -- Table doesn't exist yet (or is v1 format without pick_slot) — drop and recreate
    DROP TABLE IF EXISTS picks;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS picks (
  id           SERIAL PRIMARY KEY,
  game_id      INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  user_id      INTEGER REFERENCES users(id) ON DELETE CASCADE,
  player_name  VARCHAR(100) NOT NULL,
  pick_slot    INTEGER NOT NULL,
  created_at   TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Scoped unique constraints
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'picks_game_player') THEN
    -- Drop any old global unique on player_name first
    ALTER TABLE picks DROP CONSTRAINT IF EXISTS picks_player_name_key;
    ALTER TABLE picks ADD CONSTRAINT picks_game_player UNIQUE(game_id, player_name);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'picks_game_user_slot') THEN
    ALTER TABLE picks DROP CONSTRAINT IF EXISTS picks_user_id_pick_slot_key;
    ALTER TABLE picks ADD CONSTRAINT picks_game_user_slot UNIQUE(game_id, user_id, pick_slot);
  END IF;
END $$;

-- ── Leaderboard ───────────────────────────────────────────────────────────────
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name='leaderboard' AND column_name='game_id') THEN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='leaderboard') THEN
      ALTER TABLE leaderboard ADD COLUMN game_id INTEGER REFERENCES games(id) ON DELETE CASCADE;
      UPDATE leaderboard SET game_id = 1 WHERE game_id IS NULL;
      -- Drop old global unique, add scoped one
      ALTER TABLE leaderboard DROP CONSTRAINT IF EXISTS leaderboard_player_name_key;
    ELSE
      -- Fresh install — create table below
    END IF;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS leaderboard (
  id            SERIAL PRIMARY KEY,
  game_id       INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  player_name   VARCHAR(100) NOT NULL,
  position      INTEGER,
  score_to_par  INTEGER,
  made_cut      BOOLEAN,
  r1            INTEGER,
  r2            INTEGER,
  r3            INTEGER,
  r4            INTEGER,
  updated_at    TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'leaderboard_game_player') THEN
    ALTER TABLE leaderboard DROP CONSTRAINT IF EXISTS leaderboard_player_name_key;
    ALTER TABLE leaderboard ADD CONSTRAINT leaderboard_game_player UNIQUE(game_id, player_name);
  END IF;
END $$;

-- Add thru column to leaderboard if missing (holes played in current round)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name='leaderboard' AND column_name='thru') THEN
    ALTER TABLE leaderboard ADD COLUMN thru INTEGER;
  END IF;
END $$;

-- Add must_change_password and avatar to users if missing
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name='users' AND column_name='must_change_password') THEN
    ALTER TABLE users ADD COLUMN must_change_password BOOLEAN DEFAULT FALSE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name='users' AND column_name='avatar') THEN
    ALTER TABLE users ADD COLUMN avatar TEXT;
  END IF;
END $$;

-- Add tournament_complete, player_source and date columns to games if missing
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name='games' AND column_name='tournament_complete') THEN
    ALTER TABLE games ADD COLUMN tournament_complete BOOLEAN DEFAULT FALSE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name='games' AND column_name='player_source') THEN
    ALTER TABLE games ADD COLUMN player_source VARCHAR(20) DEFAULT 'espn';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name='games' AND column_name='tournament_start_date') THEN
    ALTER TABLE games ADD COLUMN tournament_start_date TIMESTAMP WITH TIME ZONE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name='games' AND column_name='tournament_end_date') THEN
    ALTER TABLE games ADD COLUMN tournament_end_date TIMESTAMP WITH TIME ZONE;
  END IF;
  -- Prize amounts per player (entry fee split)
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name='games' AND column_name='prize_team') THEN
    ALTER TABLE games ADD COLUMN prize_team INTEGER DEFAULT 0;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name='games' AND column_name='prize_individual') THEN
    ALTER TABLE games ADD COLUMN prize_individual INTEGER DEFAULT 0;
  END IF;
  -- Phase 1: game type, hosting, visibility
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name='games' AND column_name='game_type') THEN
    ALTER TABLE games ADD COLUMN game_type VARCHAR(30) DEFAULT 'golf_draft';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name='games' AND column_name='host_user_id') THEN
    ALTER TABLE games ADD COLUMN host_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name='games' AND column_name='is_public') THEN
    ALTER TABLE games ADD COLUMN is_public BOOLEAN DEFAULT TRUE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name='games' AND column_name='invite_code') THEN
    ALTER TABLE games ADD COLUMN invite_code VARCHAR(12);
  END IF;
  -- Backfill invite codes for any games that don't have one
  UPDATE games
  SET invite_code = UPPER(SUBSTRING(MD5(RANDOM()::TEXT) FROM 1 FOR 6))
  WHERE invite_code IS NULL;
END $$;

-- LMS columns on games
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name='games' AND column_name='lms_leagues') THEN
    ALTER TABLE games ADD COLUMN lms_leagues TEXT DEFAULT 'eng.1';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name='games' AND column_name='lms_current_week') THEN
    ALTER TABLE games ADD COLUMN lms_current_week INTEGER DEFAULT 1;
  END IF;
END $$;

-- LMS weeks
CREATE TABLE IF NOT EXISTS lms_weeks (
  id              SERIAL PRIMARY KEY,
  game_id         INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  week_number     INTEGER NOT NULL,
  deadline        TIMESTAMP WITH TIME ZONE,
  results_locked  BOOLEAN DEFAULT FALSE,
  UNIQUE(game_id, week_number)
);

-- LMS picks
CREATE TABLE IF NOT EXISTS lms_picks (
  id          SERIAL PRIMARY KEY,
  game_id     INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  week_number INTEGER NOT NULL,
  team_id     VARCHAR(20) NOT NULL,
  team_name   VARCHAR(100) NOT NULL,
  result      VARCHAR(10) DEFAULT 'pending',
  created_at  TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(game_id, user_id, week_number)
);

-- Add team_name to game_participants if missing
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name='game_participants' AND column_name='team_name') THEN
    ALTER TABLE game_participants ADD COLUMN team_name VARCHAR(50);
  END IF;
END $$;

-- Add winner_username to games if missing
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name='games' AND column_name='winner_username') THEN
    ALTER TABLE games ADD COLUMN winner_username VARCHAR(50);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name='games' AND column_name='winner_individual_username') THEN
    ALTER TABLE games ADD COLUMN winner_individual_username VARCHAR(50);
  END IF;
END $$;

-- Add is_paid to users if missing
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name='users' AND column_name='is_paid') THEN
    ALTER TABLE users ADD COLUMN is_paid BOOLEAN DEFAULT FALSE;
  END IF;
END $$;

-- Add world_rank to leaderboard if missing
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name='leaderboard' AND column_name='world_rank') THEN
    ALTER TABLE leaderboard ADD COLUMN world_rank INTEGER;
  END IF;
END $$;

-- Add reminder_sent to lms_weeks if missing
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name='lms_weeks' AND column_name='reminder_sent') THEN
    ALTER TABLE lms_weeks ADD COLUMN reminder_sent BOOLEAN DEFAULT FALSE;
  END IF;
END $$;

-- Add email to users if missing
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name='users' AND column_name='email') THEN
    ALTER TABLE users ADD COLUMN email VARCHAR(200) UNIQUE;
  END IF;
END $$;

-- ── Sessions ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS session (
  sid     VARCHAR NOT NULL COLLATE "default",
  sess    JSON NOT NULL,
  expire  TIMESTAMP(6) NOT NULL,
  CONSTRAINT session_pkey PRIMARY KEY (sid)
);

CREATE INDEX IF NOT EXISTS session_expire_idx ON session(expire);
