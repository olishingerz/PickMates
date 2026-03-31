-- PickMates v2 schema
-- If upgrading from v1: the DO blocks below handle migration automatically.
-- Fresh installs: everything is created cleanly.

-- ── Users ────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id             SERIAL PRIMARY KEY,
  username       VARCHAR(50) UNIQUE NOT NULL,
  password_hash  TEXT NOT NULL,
  draft_position INTEGER UNIQUE,
  is_admin       BOOLEAN DEFAULT FALSE,
  created_at     TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name='users' AND column_name='draft_position') THEN
    ALTER TABLE users ADD COLUMN draft_position INTEGER UNIQUE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name='users' AND column_name='is_admin') THEN
    ALTER TABLE users ADD COLUMN is_admin BOOLEAN DEFAULT FALSE;
  END IF;
END $$;

-- ── Picks ─────────────────────────────────────────────────────────────────────
-- v1 had UNIQUE(user_id); v2 needs pick_slot. Drop and recreate if migrating.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name='picks' AND column_name='pick_slot') THEN
    DROP TABLE IF EXISTS picks;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS picks (
  id           SERIAL PRIMARY KEY,
  user_id      INTEGER REFERENCES users(id) ON DELETE CASCADE,
  player_name  VARCHAR(100) NOT NULL,
  pick_slot    INTEGER NOT NULL CHECK (pick_slot BETWEEN 1 AND 6),
  created_at   TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(user_id, pick_slot),
  UNIQUE(player_name)   -- each player can only be drafted by one team
);

-- ── Leaderboard ───────────────────────────────────────────────────────────────
-- v1 had score_to_par as VARCHAR; v2 uses INTEGER. Drop and recreate if migrating.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name='leaderboard' AND column_name='made_cut') THEN
    DROP TABLE IF EXISTS leaderboard;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS leaderboard (
  id            SERIAL PRIMARY KEY,
  player_name   VARCHAR(100) UNIQUE NOT NULL,
  position      INTEGER,
  score_to_par  INTEGER,          -- E=0, -10=-10, +3=3, NULL=not yet played/no data
  made_cut      BOOLEAN,          -- true=made cut, false=missed cut, null=unknown/in progress
  r1            INTEGER,          -- round stroke scores (raw strokes, e.g. 68)
  r2            INTEGER,
  r3            INTEGER,
  r4            INTEGER,
  updated_at    TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ── Draft state ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS draft_state (
  id                  INTEGER PRIMARY KEY DEFAULT 1,
  current_pick_index  INTEGER DEFAULT 0,
  is_complete         BOOLEAN DEFAULT FALSE,
  started_at          TIMESTAMP WITH TIME ZONE,
  CONSTRAINT single_row CHECK (id = 1)
);

INSERT INTO draft_state (id, current_pick_index, is_complete)
VALUES (1, 0, FALSE)
ON CONFLICT (id) DO NOTHING;

-- ── Sessions ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS session (
  sid     VARCHAR NOT NULL COLLATE "default",
  sess    JSON NOT NULL,
  expire  TIMESTAMP(6) NOT NULL,
  CONSTRAINT session_pkey PRIMARY KEY (sid)
);

CREATE INDEX IF NOT EXISTS session_expire_idx ON session(expire);
