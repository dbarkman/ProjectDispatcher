-- Upgrade built-in top-tier agent types from Opus 4.6 to Opus 4.7.
-- Only touches is_builtin=1 rows so user-customized agents are not clobbered.
UPDATE agent_types
   SET model = 'claude-opus-4-7'
 WHERE id IN ('coding-agent', 'code-reviewer', 'security-reviewer')
   AND is_builtin = 1
   AND model = 'claude-opus-4-6';
