// Shared Zod schemas for HTTP route validation.
// One file for now — split into per-route files if this grows past ~200 lines.

import { z } from 'zod';

// --- Projects ---

export const createProjectBody = z.object({
  name: z.string().min(1).max(200),
  path: z.string().min(1),
  project_type_id: z.string().min(1),
});

export const updateProjectBody = z.object({
  name: z.string().min(1).max(200).optional(),
  project_type_id: z.string().min(1).optional(),
  status: z.enum(['active', 'dormant', 'missing', 'archived']).optional(),
});

export const listProjectsQuery = z.object({
  status: z.enum(['active', 'dormant', 'missing', 'archived']).optional(),
});

export const idParam = z.object({
  id: z.string().uuid(),
});
