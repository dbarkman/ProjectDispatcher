import type { FastifyInstance } from 'fastify';
import type { Config } from '../../config.schema.js';

export async function settingsUiRoutes(app: FastifyInstance, config: Config): Promise<void> {
  // GET /ui/settings — config editor
  app.get('/ui/settings', async (request, reply) => {
    return reply.view('settings.hbs', {
      activePage: 'settings',
      pageTitle: 'Settings',
      breadcrumbs: [{ label: 'Settings', href: '/ui/settings' }],
      config,
    });
  });
}
