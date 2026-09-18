-- Two new theme palettes (purple, alongside ember/ocean/forest/light; and
-- purpleSharp, alongside the renamed blueSharp) and a new default for
-- brand-new accounts — see public/index.html's THEMES list and CSS.
--
-- blueSharp is a straight rename of what used to just be "sharp" (same
-- palette, same accent) now that there's a family of "*Sharp" themes —
-- existing rows still holding the literal string 'sharp' get carried
-- forward so they don't silently fall back to a mismatched swatch
-- selection in the UI. Existing 'ember' rows are deliberately left
-- alone: unlike a branding string nobody bothers to change, a theme is
-- something people actively pick, so only NEW accounts get the new
-- default.
ALTER TABLE userdata ALTER COLUMN theme SET DEFAULT 'blueSharp';
UPDATE userdata SET theme = 'blueSharp' WHERE theme = 'sharp';
