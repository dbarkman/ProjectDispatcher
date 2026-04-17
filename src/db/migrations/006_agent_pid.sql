-- Track agent subprocess PIDs so recovery can distinguish "process died"
-- from "process still running detached" after a daemon restart.

ALTER TABLE agent_runs ADD COLUMN pid INTEGER;
