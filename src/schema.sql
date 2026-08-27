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
  -- When tournament_complete actually flipped to TRUE — distinct from
  -- tournament_end_date, which is the real-world event's schedule date (from
  -- ESPN for golf_draft) and is NULL for manually-completed LMS/scorecard games.
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name='games' AND column_name='completed_at') THEN
    ALTER TABLE games ADD COLUMN completed_at TIMESTAMP WITH TIME ZONE;
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
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name='games' AND column_name='lms_continuous') THEN
    ALTER TABLE games ADD COLUMN lms_continuous BOOLEAN DEFAULT FALSE;
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

-- LMS win history — persists across resets, since a single LMS game can be replayed
-- (won, then reopened as a lobby) many times
CREATE TABLE IF NOT EXISTS lms_winners (
  id           SERIAL PRIMARY KEY,
  game_id      INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  user_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  username     VARCHAR(50),
  is_rollover  BOOLEAN DEFAULT FALSE,
  final_week   INTEGER,
  prize_amount NUMERIC,
  created_at   TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Add team_name to game_participants if missing
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name='game_participants' AND column_name='team_name') THEN
    ALTER TABLE game_participants ADD COLUMN team_name VARCHAR(50);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name='game_participants' AND column_name='last_rank') THEN
    ALTER TABLE game_participants ADD COLUMN last_rank INTEGER;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name='game_participants' AND column_name='has_paid') THEN
    ALTER TABLE game_participants ADD COLUMN has_paid BOOLEAN DEFAULT FALSE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name='game_participants' AND column_name='is_co_host') THEN
    ALTER TABLE game_participants ADD COLUMN is_co_host BOOLEAN DEFAULT FALSE;
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

-- Add fixtures_cache to lms_weeks if missing — the pickable team list is fetched
-- from ESPN once per round and stored here, instead of live on every page view
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name='lms_weeks' AND column_name='fixtures_cache') THEN
    ALTER TABLE lms_weeks ADD COLUMN fixtures_cache JSONB;
  END IF;
END $$;

-- A round with 5 or fewer surviving (non-postponed) fixtures is voided —
-- locked so it's never retried, but excluded from elimination entirely, so
-- nobody goes out based on it even if their own pick's result came through.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name='lms_weeks' AND column_name='skipped') THEN
    ALTER TABLE lms_weeks ADD COLUMN skipped BOOLEAN DEFAULT FALSE;
  END IF;
END $$;

-- Add display_name to users if missing
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name='users' AND column_name='display_name') THEN
    ALTER TABLE users ADD COLUMN display_name VARCHAR(50);
  END IF;
END $$;

-- Add email to users if missing
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name='users' AND column_name='email') THEN
    ALTER TABLE users ADD COLUMN email VARCHAR(200) UNIQUE;
  END IF;
END $$;

-- One-shot "add your email" prompt for existing accounts with none set —
-- shown at most once ever per user, right after their next login.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name='users' AND column_name='email_prompt_shown') THEN
    ALTER TABLE users ADD COLUMN email_prompt_shown BOOLEAN DEFAULT FALSE;
  END IF;
END $$;

-- Per-notification-type opt-in/opt-out, toggled from the profile page.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name='users' AND column_name='notify_draft_turn') THEN
    ALTER TABLE users ADD COLUMN notify_draft_turn BOOLEAN DEFAULT FALSE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name='users' AND column_name='notify_lms_deadline') THEN
    ALTER TABLE users ADD COLUMN notify_lms_deadline BOOLEAN DEFAULT FALSE;
  END IF;
END $$;
-- Both used to default TRUE for anyone with an email set — now opt-in instead,
-- so new accounts get FALSE going forward...
ALTER TABLE users ALTER COLUMN notify_draft_turn   SET DEFAULT FALSE;
ALTER TABLE users ALTER COLUMN notify_lms_deadline SET DEFAULT FALSE;

-- Tracks one-off data migrations that can't be made idempotent just by their
-- own WHERE clause (e.g. flipping a default where a user might deliberately
-- choose the old value again afterward, which a plain re-runnable UPDATE
-- would keep undoing on every deploy).
CREATE TABLE IF NOT EXISTS schema_migrations (
  name        VARCHAR(100) PRIMARY KEY,
  applied_at  TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ...and existing users get switched off once here, rather than staying
-- opted in from the old default.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE name = 'notify_default_off_2026') THEN
    UPDATE users SET notify_draft_turn = FALSE, notify_lms_deadline = FALSE;
    INSERT INTO schema_migrations (name) VALUES ('notify_default_off_2026');
  END IF;
END $$;

-- Password reset tokens — store only a hash (sha256, hex) of the token that
-- goes out by email, never the raw value, so a DB leak alone can't be used to
-- reset an account.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name='users' AND column_name='reset_token_hash') THEN
    ALTER TABLE users ADD COLUMN reset_token_hash VARCHAR(64);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name='users' AND column_name='reset_token_expires') THEN
    ALTER TABLE users ADD COLUMN reset_token_expires TIMESTAMP WITH TIME ZONE;
  END IF;
END $$;

-- Free-text payment details (bank transfer, PayPal, etc.) a host can share
-- with players who haven't paid yet — shown on the LMS page, never anywhere
-- else, and only to the players who still owe money.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name='users' AND column_name='payment_details') THEN
    ALTER TABLE users ADD COLUMN payment_details TEXT;
  END IF;
END $$;

-- ── Friends ───────────────────────────────────────────────────────────────────
-- One-directional "quick add" list — adding someone doesn't add you to their
-- list, and there's no request/accept step. Purely a personal shortcut for
-- adding known players to a game without retyping their username.
CREATE TABLE IF NOT EXISTS friends (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  friend_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(user_id, friend_id),
  CHECK (user_id <> friend_id)
);
CREATE INDEX IF NOT EXISTS idx_friends_user ON friends(user_id);

-- ── Round-by-round rank history ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS game_rank_history (
  id          SERIAL PRIMARY KEY,
  game_id     INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rank        INTEGER NOT NULL,
  team_score  INTEGER,
  round       INTEGER NOT NULL,
  recorded_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(game_id, user_id, round)
);

-- Add is_banned to users if missing
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name='users' AND column_name='is_banned') THEN
    ALTER TABLE users ADD COLUMN is_banned BOOLEAN DEFAULT FALSE;
  END IF;
END $$;

-- Add last_seen to users if missing (rename from last_login if that exists)
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name='users' AND column_name='last_login') THEN
    ALTER TABLE users RENAME COLUMN last_login TO last_seen;
  ELSIF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_name='users' AND column_name='last_seen') THEN
    ALTER TABLE users ADD COLUMN last_seen TIMESTAMP WITH TIME ZONE;
  END IF;
END $$;

-- Drop display_name from users (feature removed)
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name='users' AND column_name='display_name') THEN
    ALTER TABLE users DROP COLUMN display_name;
  END IF;
END $$;

-- Drop event feed tables if they exist (feature removed)
DROP TABLE IF EXISTS game_event_reactions;
DROP TABLE IF EXISTS game_events;

-- Add round_status to games if missing
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name='games' AND column_name='round_status') THEN
    ALTER TABLE games ADD COLUMN round_status JSONB;
  END IF;
END $$;

-- ── Site settings (singleton row) ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS site_settings (
  id                     INTEGER PRIMARY KEY DEFAULT 1,
  game_creation_roles    TEXT DEFAULT 'admin,paid',
  CONSTRAINT site_settings_single_row CHECK (id = 1)
);
INSERT INTO site_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- ── Sessions ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS session (
  sid     VARCHAR NOT NULL COLLATE "default",
  sess    JSON NOT NULL,
  expire  TIMESTAMP(6) NOT NULL,
  CONSTRAINT session_pkey PRIMARY KEY (sid)
);

CREATE INDEX IF NOT EXISTS session_expire_idx ON session(expire);

-- ── Indexes for "this user, across all their games" lookups ────────────────────
-- game_participants/picks/lms_picks only had composite unique indexes with
-- game_id as the leading column, which Postgres can't use for a user_id-only
-- filter (e.g. the profile page's pick history across every game a user's in).
CREATE INDEX IF NOT EXISTS idx_game_participants_user ON game_participants(user_id);
CREATE INDEX IF NOT EXISTS idx_picks_user             ON picks(user_id);
CREATE INDEX IF NOT EXISTS idx_lms_picks_user          ON lms_picks(user_id);

-- Golf Scorecard columns on games
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name='games' AND column_name='scorecard_course_name') THEN
    ALTER TABLE games ADD COLUMN scorecard_course_name VARCHAR(200);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name='games' AND column_name='scorecard_course_par') THEN
    ALTER TABLE games ADD COLUMN scorecard_course_par INTEGER;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name='games' AND column_name='scorecard_entry_fee') THEN
    ALTER TABLE games ADD COLUMN scorecard_entry_fee INTEGER DEFAULT 0;
  END IF;
  -- 'team' (default, existing behaviour) or 'individual' — individual games have no
  -- teams and no tee times, just each player's own net Stableford score.
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name='games' AND column_name='scorecard_format') THEN
    ALTER TABLE games ADD COLUMN scorecard_format VARCHAR(20) DEFAULT 'team';
  END IF;
END $$;

-- Golf Scorecard: 18 holes per game (par + stroke index)
CREATE TABLE IF NOT EXISTS scorecard_holes (
  id            SERIAL PRIMARY KEY,
  game_id       INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  hole_number   INTEGER NOT NULL,
  par           INTEGER NOT NULL,
  stroke_index  INTEGER NOT NULL,
  UNIQUE(game_id, hole_number)
);

-- Add is_ctp to scorecard_holes if missing — whether this hole is one of the
-- host-selected closest-to-the-pin holes (only meaningful for par 3s)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name='scorecard_holes' AND column_name='is_ctp') THEN
    ALTER TABLE scorecard_holes ADD COLUMN is_ctp BOOLEAN DEFAULT TRUE;
  END IF;
END $$;

-- Golf Scorecard: named teams
CREATE TABLE IF NOT EXISTS scorecard_teams (
  id          SERIAL PRIMARY KEY,
  game_id     INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  name        VARCHAR(100) NOT NULL,
  created_at  TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Golf Scorecard columns on game_participants (team, handicap, captain)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name='game_participants' AND column_name='scorecard_team_id') THEN
    ALTER TABLE game_participants ADD COLUMN scorecard_team_id INTEGER REFERENCES scorecard_teams(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name='game_participants' AND column_name='handicap') THEN
    ALTER TABLE game_participants ADD COLUMN handicap NUMERIC(4,1);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name='game_participants' AND column_name='is_captain') THEN
    ALTER TABLE game_participants ADD COLUMN is_captain BOOLEAN DEFAULT FALSE;
  END IF;
END $$;

-- Golf Scorecard: per-player, per-hole strokes
CREATE TABLE IF NOT EXISTS scorecard_scores (
  id              SERIAL PRIMARY KEY,
  game_id         INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  participant_id  INTEGER NOT NULL REFERENCES game_participants(id) ON DELETE CASCADE,
  hole_number     INTEGER NOT NULL,
  strokes         INTEGER NOT NULL,
  updated_at      TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(participant_id, hole_number)
);

-- Golf Scorecard: closest-to-the-pin on par-3 holes — one holder per hole,
-- game-wide (not per-team); nominating someone new replaces the previous holder.
CREATE TABLE IF NOT EXISTS scorecard_closest_to_pin (
  id              SERIAL PRIMARY KEY,
  game_id         INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  hole_number     INTEGER NOT NULL,
  participant_id  INTEGER NOT NULL REFERENCES game_participants(id) ON DELETE CASCADE,
  created_at      TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(game_id, hole_number)
);

-- Golf Scorecard: saved course library, per user — lets a host reuse a course's
-- par/hole setup next time instead of re-entering all 18 holes.
CREATE TABLE IF NOT EXISTS saved_courses (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        VARCHAR(200) NOT NULL,
  par         INTEGER NOT NULL,
  created_at  TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS saved_course_holes (
  id            SERIAL PRIMARY KEY,
  course_id     INTEGER NOT NULL REFERENCES saved_courses(id) ON DELETE CASCADE,
  hole_number   INTEGER NOT NULL,
  par           INTEGER NOT NULL,
  stroke_index  INTEGER NOT NULL,
  UNIQUE(course_id, hole_number)
);

-- Golf Scorecard: tee times — an independent grouping from teams, representing
-- who physically plays together on the course. Optional; set up in the lobby.
CREATE TABLE IF NOT EXISTS scorecard_tee_times (
  id          SERIAL PRIMARY KEY,
  game_id     INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  label       VARCHAR(50) NOT NULL,
  created_at  TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Add scorecard_tee_time_id to game_participants if missing
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name='game_participants' AND column_name='scorecard_tee_time_id') THEN
    ALTER TABLE game_participants ADD COLUMN scorecard_tee_time_id INTEGER REFERENCES scorecard_tee_times(id) ON DELETE SET NULL;
  END IF;
END $$;

-- Allow a user to hold more than one LMS entry in the same game (extra
-- "lives" for players who want more chances to win) — golf_draft/golf_scorecard
-- are unaffected since their own add-player/join routes already reject a
-- duplicate user_id at the app level before this constraint would ever fire.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'game_participants_game_id_user_id_key') THEN
    ALTER TABLE game_participants DROP CONSTRAINT game_participants_game_id_user_id_key;
  END IF;
END $$;

-- Each lms_picks row needs to belong to one specific entry (game_participants
-- row), not just a user — a user with two entries in the same game needs each
-- entry's picks tracked independently.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name='lms_picks' AND column_name='participant_id') THEN
    ALTER TABLE lms_picks ADD COLUMN participant_id INTEGER REFERENCES game_participants(id) ON DELETE CASCADE;
  END IF;
END $$;

-- One-time backfill: every existing pick predates the participant_id column,
-- but today every player has exactly one entry per game, so game_id+user_id
-- unambiguously identifies the right game_participants row to backfill from.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE name = 'lms_picks_participant_id_backfill') THEN
    UPDATE lms_picks lp
    SET participant_id = gp.id
    FROM game_participants gp
    WHERE gp.game_id = lp.game_id AND gp.user_id = lp.user_id AND lp.participant_id IS NULL;
    INSERT INTO schema_migrations (name) VALUES ('lms_picks_participant_id_backfill');
  END IF;
END $$;

-- Once backfilled, participant_id becomes the real identity of a pick — swap
-- the uniqueness key from (game_id,user_id,week_number) to (participant_id,week_number)
-- so two entries owned by the same user_id can each pick independently per week.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE name = 'lms_picks_participant_id_not_null') THEN
    ALTER TABLE lms_picks ALTER COLUMN participant_id SET NOT NULL;
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lms_picks_game_id_user_id_week_number_key') THEN
      ALTER TABLE lms_picks DROP CONSTRAINT lms_picks_game_id_user_id_week_number_key;
    END IF;
    ALTER TABLE lms_picks ADD CONSTRAINT lms_picks_participant_week UNIQUE(participant_id, week_number);
    INSERT INTO schema_migrations (name) VALUES ('lms_picks_participant_id_not_null');
  END IF;
END $$;

-- Lightweight event log for the home dashboard's "Recent Activity" feed —
-- a pre-rendered human-readable message per row rather than a structured
-- per-event-type schema, since the feed only ever displays it as-is.
CREATE TABLE IF NOT EXISTS activity_log (
  id          SERIAL PRIMARY KEY,
  game_id     INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  message     TEXT NOT NULL,
  created_at  TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_activity_log_created ON activity_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_log_game     ON activity_log(game_id);

-- One row per page load — powers the admin "Visitors" page. Logged for every
-- viewer including anonymous ones (user_id null), so the host can see actual
-- traffic, not just registered-user activity.
CREATE TABLE IF NOT EXISTS page_views (
  id          SERIAL PRIMARY KEY,
  path        TEXT NOT NULL,
  ip_address  VARCHAR(64),
  user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  user_agent  TEXT,
  created_at  TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_page_views_created ON page_views(created_at DESC);

-- Replaces the old is_public boolean with a 3-state setting — "can people
-- see this game" and "can people join it themselves" turned out to be two
-- different questions (e.g. visible to everyone but invite-only to join).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name='games' AND column_name='visibility') THEN
    ALTER TABLE games ADD COLUMN visibility VARCHAR(20) NOT NULL DEFAULT 'public'
      CHECK (visibility IN ('public','invite_only','private'));
  END IF;
END $$;

-- One-time backfill from the old column — only relevant for a database that
-- already had is_public; a fresh install's visibility column already
-- defaults correctly on its own and never had is_public in the first place.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='games' AND column_name='is_public')
     AND NOT EXISTS (SELECT 1 FROM schema_migrations WHERE name = 'games_visibility_backfill') THEN
    UPDATE games SET visibility = CASE WHEN is_public = FALSE THEN 'private' ELSE 'public' END;
    INSERT INTO schema_migrations (name) VALUES ('games_visibility_backfill');
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='games' AND column_name='is_public') THEN
    ALTER TABLE games DROP COLUMN is_public;
  END IF;
END $$;

-- ── One-time data fixes ───────────────────────────────────────────────────────
-- Fix ESPN name mismatches for Masters 2026 (Samuel Stevens / Nicolas Echavarria)
UPDATE picks SET player_name = 'Sam Stevens'
WHERE LOWER(TRIM(player_name)) = 'samuel stevens';

UPDATE picks SET player_name = 'Nico Echavarria'
WHERE LOWER(TRIM(player_name)) = 'nicolas echavarria';
