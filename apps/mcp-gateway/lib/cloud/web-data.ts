import { z } from 'zod';
import { MediaService, type CloudEnv } from './service.ts';
import { deleteSchema } from './data-management.ts';
import { platformSchema } from './contracts.ts';
import { readSameOriginForm } from './web-forms.ts';
export async function manageDataFromWeb(request: Request, userId: string | null, config: CloudEnv) {
  const form = await readSameOriginForm(request, userId);
  const input = z.discriminatedUnion('action', [deleteSchema.extend({ action: z.literal('delete'), confirmed: z.literal('yes') }), z.object({ action: z.literal('resume'), platform: platformSchema }).strict()]).parse(form);
  const service = new MediaService(config); await service.store.owner(userId!);
  if (input.action === 'delete') { const { action: _action, confirmed: _confirmed, ...args } = input; return { action: input.action, ...await service.call('delete_personal_data', args) }; }
  return { action: input.action, ...await service.call('resume_platform_sync', { platform: input.platform }) };
}
