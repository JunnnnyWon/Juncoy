import { z } from 'zod';
export const ImageGenerationPlan = z.strictObject({
  operation: z.enum(['new', 'edit', 'variant', 'recompose']),
  output: z.enum(['character', 'background', 'game_scene', 'ui', 'other']),
  preserve: z.array(z.string().max(500)).max(16),
  change: z.array(z.string().max(500)).max(16),
  free: z.array(z.string().max(500)).max(16),
  primary: z.object({ id: z.string().uuid(), hash: z.string().regex(/^[0-9a-f]{64}$/), purpose: z.string().max(1000) }).nullable(),
  supporting: z.array(z.object({ id: z.string().uuid(), hash: z.string().regex(/^[0-9a-f]{64}$/), purpose: z.string().max(1000) })).max(15),
});
export type ImageGenerationPlan = z.infer<typeof ImageGenerationPlan>;
