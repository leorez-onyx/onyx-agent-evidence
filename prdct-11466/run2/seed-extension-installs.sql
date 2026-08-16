BEGIN;
SET search_path TO onyx_security, public;
DELETE FROM extension_installations WHERE installation_id LIKE 'E2E-EXT-%';
INSERT INTO extension_installations
  (installation_id, email, profile_type, created_at, updated_at, current_version, browser, platform, last_communicated_at)
VALUES
  ('E2E-EXT-1', 'a@onyx.security', 'work', now(), now(), '2.7.1',  'chrome', 'macOS',   now() - interval '10 minutes'),
  ('E2E-EXT-2', 'b@onyx.security', 'work', now(), now(), '2.7.1',  'chrome', 'macOS',   now() - interval '20 minutes'),
  ('E2E-EXT-3', 'c@onyx.security', 'work', now(), now(), '2.6.0',  'edge',   'Windows', now() - interval '30 minutes'),
  ('E2E-EXT-4', 'd@onyx.security', 'work', now(), now(), NULL,     'chrome', 'macOS',   now() - interval '40 minutes');
COMMIT;
SELECT current_version, count(*) FROM onyx_security.extension_installations GROUP BY 1 ORDER BY 2 DESC;
