import { createHash } from 'node:crypto';

export interface VisionObservation {
  description: string;
  visible_text: string[];
  subjects: string[];
  materials: string[];
  lighting: string[];
  palette: string[];
  confidence_note: string;
  source_sha256: string;
  model: string;
}

export class OpenRouterVision {
  constructor(
    private apiKey: string,
    private model = 'google/gemini-3.7-flash',
    private baseUrl = 'https://openrouter.ai/api/v1',
  ) {}

  async analyzeImage(bytes: Buffer, mime: string): Promise<VisionObservation> {
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(mime))
      throw new Error('unsupported_vision_mime');
    const sourceSha256 = createHash('sha256').update(bytes).digest('hex');
    const imageUrl = 'data:' + mime + ';base64,' + bytes.toString('base64');
    const response = await fetch(this.baseUrl + '/chat/completions', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + this.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        temperature: 0.1,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: 'Describe this image for a project knowledge index. Return JSON with description, visible_text, subjects, materials, lighting, palette, confidence_note. Do not infer approval, ownership, art direction, or facts not visible in the image.',
              },
              { type: 'image_url', image_url: { url: imageUrl } },
            ],
          },
        ],
      }),
      signal: AbortSignal.timeout(90_000),
    });
    if (!response.ok)
      throw Object.assign(new Error('openrouter_vision_' + response.status), {
        status: response.status,
      });
    const payload = (await response.json()) as any;
    const content = payload.choices?.[0]?.message?.content;
    if (typeof content !== 'string') throw new Error('openrouter_vision_empty_response');
    const result = JSON.parse(content);
    return {
      description: String(result.description ?? ''),
      visible_text: Array.isArray(result.visible_text) ? result.visible_text.map(String) : [],
      subjects: Array.isArray(result.subjects) ? result.subjects.map(String) : [],
      materials: Array.isArray(result.materials) ? result.materials.map(String) : [],
      lighting: Array.isArray(result.lighting) ? result.lighting.map(String) : [],
      palette: Array.isArray(result.palette) ? result.palette.map(String) : [],
      confidence_note: String(result.confidence_note ?? ''),
      source_sha256: sourceSha256,
      model: this.model,
    };
  }
}
