-- E2E fixture for the Endpoint Scanner Version filter (PRDCT-11466).
--
-- Devices and the scanner-version shape each acceptance test needs:
--   e2e-dev-a  historical 1.2.0 scan + latest 1.4.2   -> latest-scan-only proof
--   e2e-dev-b  1.4.2
--   e2e-dev-c  2026-07-30-1015-4f2c9d1 (staging date-id form)
--   e2e-dev-d  1.2.0
--   e2e-dev-f  latest scan carries NO version         -> the "Unknown" bucket
--   e2e-dev-g  ONE run: host row 3.0.0-host (older) + container row 3.0.0-container (newer)
--              -> the representative-row case; the facet must offer the HOST build.
BEGIN;

SET search_path TO onyx_security, public;

DELETE FROM scanner_installations WHERE device_id IN (SELECT id FROM devices WHERE device_id LIKE 'E2E-SERIAL-%');
DELETE FROM devices WHERE device_id LIKE 'E2E-SERIAL-%';

INSERT INTO devices (name, device_id, platform, os_version, created_at, updated_at)
VALUES
  ('e2e-dev-a', 'E2E-SERIAL-a', 'darwin', '14.0', now(), now()),
  ('e2e-dev-b', 'E2E-SERIAL-b', 'darwin', '14.0', now(), now()),
  ('e2e-dev-c', 'E2E-SERIAL-c', 'darwin', '14.0', now(), now()),
  ('e2e-dev-d', 'E2E-SERIAL-d', 'darwin', '14.0', now(), now()),
  ('e2e-dev-f', 'E2E-SERIAL-f', 'darwin', '14.0', now(), now()),
  ('e2e-dev-g', 'E2E-SERIAL-g', 'linux',  '22.04', now(), now());

INSERT INTO scanner_installations
  (device_id, non_employee_users, employee_ids, scan_command, scan_result,
   scanned_at, total_agents, total_mcp_servers, total_skills,
   scanner_version, scan_correlation_id, host_type)
SELECT d.id, '{}', '{}', 'onyx scan', '{}'::jsonb, s.scanned_at, 0, 0, 0,
       s.scanner_version, s.corr, s.host_type
FROM (VALUES
  ('e2e-dev-a', now() - interval '2 days',   '1.2.0',                   NULL, NULL),
  ('e2e-dev-a', now() - interval '40 minutes','1.4.2',                  NULL, NULL),
  ('e2e-dev-b', now() - interval '30 minutes','1.4.2',                  NULL, NULL),
  ('e2e-dev-c', now() - interval '20 minutes','2026-07-30-1015-4f2c9d1',NULL, NULL),
  ('e2e-dev-d', now() - interval '10 minutes','1.2.0',                  NULL, NULL),
  ('e2e-dev-f', now() - interval '5 minutes', NULL,                     NULL, NULL),
  ('e2e-dev-g', now() - interval '50 minutes','3.0.0-host',      'e2e-run-g', NULL),
  ('e2e-dev-g', now() - interval '45 minutes','3.0.0-container', 'e2e-run-g', 'HostTypeContainerized')
) AS s(device_name, scanned_at, scanner_version, corr, host_type)
JOIN devices d ON d.name = s.device_name;

COMMIT;

SELECT d.name AS device,
       si.scanned_at,
       si.scanner_version,
       si.scan_correlation_id,
       si.host_type
FROM onyx_security.scanner_installations si
JOIN onyx_security.devices d ON d.id = si.device_id
WHERE d.device_id LIKE 'E2E-SERIAL-%'
ORDER BY d.name, si.scanned_at;

-- e2e-dev-h: only scan is 30 days old, so the page's default Last-7-days window excludes it.
-- Its version must NOT be offered while that window is active.
INSERT INTO onyx_security.devices (name, device_id, platform, os_version, created_at, updated_at)
VALUES ('e2e-dev-h', 'E2E-SERIAL-h', 'darwin', '14.0', now(), now());

INSERT INTO onyx_security.scanner_installations
  (device_id, non_employee_users, employee_ids, scan_command, scan_result,
   scanned_at, total_agents, total_mcp_servers, total_skills, scanner_version)
SELECT id, '{}', '{}', 'onyx scan', '{}'::jsonb, now() - interval '30 days', 0, 0, 0, '0.9.0-stale'
FROM onyx_security.devices WHERE name = 'e2e-dev-h';
