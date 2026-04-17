-- Add worktree_path to agent_runs for parallel coding agent support.
-- When parallel_coding is enabled, each agent run gets its own git worktree.
-- This column tracks the worktree path so recovery can clean up orphaned ones.

ALTER TABLE agent_runs ADD COLUMN worktree_path TEXT;
