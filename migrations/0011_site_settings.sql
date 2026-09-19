-- Light site branding (title / logo / accent). Not a theme store.
-- One row; id is always 1.

CREATE TABLE site_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  site_title TEXT NOT NULL DEFAULT 'Postgrove',
  logo_url TEXT,
  accent TEXT NOT NULL DEFAULT '#1B4332',
  updated_at INTEGER NOT NULL
);

INSERT INTO site_settings (id, site_title, logo_url, accent, updated_at)
VALUES (1, 'Postgrove', NULL, '#1B4332', 0);
