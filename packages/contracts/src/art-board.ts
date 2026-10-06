import { z } from 'zod';

export const ArtCanvasNode = z.strictObject({
  id: z.string().min(1).max(200),
  node_type: z.enum(['text_note', 'frame', 'group']),
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().min(80).max(5000),
  height: z.number().min(60).max(5000),
  text: z.string().max(4000),
});
export type ArtCanvasNode = z.infer<typeof ArtCanvasNode>;
export const ArtCanvasEdge = z.strictObject({
  id: z.string().min(1).max(200),
  source: z.string().min(1),
  target: z.string().min(1),
  edge_type: z.enum(['supports', 'contradicts', 'variant_of', 'uses_only', 'derived_from']),
});
export type ArtCanvasEdge = z.infer<typeof ArtCanvasEdge>;
export const ArtBoardSnapshot = z.object({
  references: z.array(z.object({ id: z.string().min(1).max(200) }).passthrough()).max(200).default([]),
  nodes: z.array(ArtCanvasNode).max(500).default([]),
  edges: z.array(ArtCanvasEdge).max(1000).default([]),
  viewport: z.object({ x: z.number().finite(), y: z.number().finite(), zoom: z.number().min(0.5).max(1.8) }).optional(),
}).superRefine((snapshot, ctx) => {
  const ids = [...snapshot.references.map((r) => r.id), ...snapshot.nodes.map((n) => n.id)];
  if (new Set(ids).size !== ids.length) ctx.addIssue({ code: 'custom', message: 'duplicate_node_id' });
  const known = new Set(ids);
  const edges = new Set<string>();
  const edgeIds = new Set<string>();
  for (const edge of snapshot.edges) {
    const key = JSON.stringify([edge.source, edge.target, edge.edge_type]);
    if (edge.source === edge.target || !known.has(edge.source) || !known.has(edge.target))
      ctx.addIssue({ code: 'custom', message: 'invalid_edge_endpoint' });
    if (edges.has(key) || edgeIds.has(edge.id)) ctx.addIssue({ code: 'custom', message: 'duplicate_edge' });
    edges.add(key);
    edgeIds.add(edge.id);
  }
});
