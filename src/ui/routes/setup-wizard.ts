import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { FastifyInstance } from 'fastify';

export async function setupWizardRoutes(app: FastifyInstance): Promise<void> {
  app.get('/ui/setup', async (_request, reply) => {
    const credentialsPath = join(homedir(), '.claude', 'credentials.json');
    let oauthDetected = false;
    try {
      await access(credentialsPath);
      oauthDetected = true;
    } catch {
      // credentials.json not found
    }

    return reply.view('setup-wizard.hbs', {
      activePage: 'settings',
      pageTitle: 'Setup',
      breadcrumbs: [{ label: 'Setup', href: '/ui/setup' }],
      oauthDetected,
    });
  });
}
