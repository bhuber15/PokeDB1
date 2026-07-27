-- FTS5 trigram index over catalogue card names, for fuzzy-search candidate
-- retrieval (lib/domain/card-search.ts). External content: the index reads
-- name/alias_name through to `cards` by rowid (= `id`, an INTEGER PRIMARY
-- KEY), so it stores only the trigram index, and the triggers below keep it
-- in sync. Hand-written: drizzle-kit cannot model virtual tables.
CREATE VIRTUAL TABLE `cards_fts` USING fts5(
  `name`,
  `alias_name`,
  content='cards',
  content_rowid='id',
  tokenize='trigram'
);--> statement-breakpoint
CREATE TRIGGER `cards_fts_ai` AFTER INSERT ON `cards` BEGIN
  INSERT INTO `cards_fts`(rowid, name, alias_name) VALUES (new.id, new.name, new.alias_name);
END;--> statement-breakpoint
-- The nightly catalogue sweep upserts every row (ON CONFLICT DO UPDATE), so
-- an unguarded update trigger would re-tokenize the whole catalogue nightly.
-- The WHEN clause (IS NOT = null-safe) skips rows whose indexed values did
-- not actually change.
CREATE TRIGGER `cards_fts_au` AFTER UPDATE ON `cards`
WHEN old.name IS NOT new.name OR old.alias_name IS NOT new.alias_name OR old.id IS NOT new.id BEGIN
  INSERT INTO `cards_fts`(`cards_fts`, rowid, name, alias_name) VALUES ('delete', old.id, old.name, old.alias_name);
  INSERT INTO `cards_fts`(rowid, name, alias_name) VALUES (new.id, new.name, new.alias_name);
END;--> statement-breakpoint
CREATE TRIGGER `cards_fts_ad` AFTER DELETE ON `cards` BEGIN
  INSERT INTO `cards_fts`(`cards_fts`, rowid, name, alias_name) VALUES ('delete', old.id, old.name, old.alias_name);
END;--> statement-breakpoint
-- Index every card that predates the triggers.
INSERT INTO `cards_fts`(`cards_fts`) VALUES ('rebuild');
