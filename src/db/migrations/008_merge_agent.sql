-- Add merge-agent agent type and 'merging' column to software-dev and
-- vps-maintenance project types. Inserts are guarded with NOT EXISTS so
-- the migration is safe if the rows were manually created before upgrade.

-- 1. Insert merge-agent agent type (needed before FK reference in columns).
--    The coding-agent guard skips this on fresh DBs where seed hasn't run
--    yet — the seed creates everything from scratch on fresh DBs.
INSERT INTO agent_types (
  id, name, description, system_prompt_path, model, allowed_tools,
  permission_mode, timeout_minutes, max_retries, is_builtin, created_at, updated_at
)
SELECT
  'merge-agent',
  'Merge Agent',
  'Handles git merges and simple conflict resolution for completed tickets.',
  'merge-agent.md',
  'claude-opus-4-7',
  '["Bash","Read","Edit","Grep"]',
  'acceptEdits',
  10,
  2,
  1,
  strftime('%s','now') * 1000,
  strftime('%s','now') * 1000
WHERE EXISTS (SELECT 1 FROM agent_types WHERE id = 'coding-agent')
  AND NOT EXISTS (SELECT 1 FROM agent_types WHERE id = 'merge-agent');

-- 2. software-dev: shift 'done' from order 4 → 5, insert 'merging' at order 4.
--    On a fresh DB the project_types table is still empty (seed hasn't run),
--    so the UPDATE is a no-op and the INSERT is skipped. The seed handles
--    fresh DBs; this migration handles existing DBs where seed already ran.
UPDATE project_type_columns
   SET "order" = 5
 WHERE project_type_id = 'software-dev' AND column_id = 'done' AND "order" = 4;

INSERT INTO project_type_columns (project_type_id, column_id, name, agent_type_id, "order")
SELECT 'software-dev', 'merging', 'Merging', 'merge-agent', 4
 WHERE EXISTS (SELECT 1 FROM project_types WHERE id = 'software-dev')
   AND NOT EXISTS (
     SELECT 1 FROM project_type_columns
      WHERE project_type_id = 'software-dev' AND column_id = 'merging'
   );

-- 3. vps-maintenance: shift 'done' from order 3 → 4, insert 'merging' at order 3.
UPDATE project_type_columns
   SET "order" = 4
 WHERE project_type_id = 'vps-maintenance' AND column_id = 'done' AND "order" = 3;

INSERT INTO project_type_columns (project_type_id, column_id, name, agent_type_id, "order")
SELECT 'vps-maintenance', 'merging', 'Merging', 'merge-agent', 3
 WHERE EXISTS (SELECT 1 FROM project_types WHERE id = 'vps-maintenance')
   AND NOT EXISTS (
     SELECT 1 FROM project_type_columns
      WHERE project_type_id = 'vps-maintenance' AND column_id = 'merging'
   );
