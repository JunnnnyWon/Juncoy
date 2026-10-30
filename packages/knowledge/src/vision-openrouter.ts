import { createHash } from 'node:crypto';

export interface VisionObservation {
  description: string;
  visible_text: string[];
  subjects: string[];
  materials: string[];
  lighting: string[];
  palette: string[];
  /** 검색용 키워드 — 한국어 명사 + 영어 원어. 파일명 단어의 한국어 번역 포함. */
  search_keywords?: string[];
  confidence_note: string;
  source_sha256: string;
  model: string;
  style_features?: Record<string, unknown>;
  scene_content?: Record<string, unknown>;
}

/** 프롬프트에 넣는 파일명 — 글자·숫자·공백·일부 기호만 남겨 지시문 주입을 막는다. */
export function promptFilename(filename: string) {
  return filename.replace(/[^\p{L}\p{N} ._()-]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
}

export class OpenRouterVision {
  constructor(
    private apiKey: string,
    private model = 'google/gemini-3.7-flash',
    private baseUrl = 'https://openrouter.ai/api/v1',
  ) {}

  async analyzeImage(bytes: Buffer, mime: string, filename?: string): Promise<VisionObservation> {
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
                text: '프로젝트 참고 이미지의 description, visible_text, subjects, materials, lighting, palette, confidence_note를 한국어 JSON으로 반환한다. style_features(모델링 방식, 얼굴 표현 방식, 재질, 텍스처, 색감, 조명)와 scene_content(인물, 의상, 자세, 행동, 장소, 오브젝트, 카메라 구도)를 별도 객체로 반환한다. 스타일에 특정 인물이나 행동을 포함하지 않는다. 승인, 소유권이나 보이지 않는 사실을 추정하지 않는다. search_keywords에는 팀원이 이 이미지를 찾을 때 쓸 검색어를 10~20개 넣는다. 보이는 대상의 한국어 명사와 영어 단어를 함께 넣는다(예: 소녀, girl, 눈동자, eye).' + (filename ? ' 업로더가 붙인 파일명은 [' + promptFilename(filename) + ']이다. 파일명의 단어와 그 한국어 번역·동의어(예: girl → 소녀, 여자아이)를 search_keywords에 꼭 넣는다. 파일명은 검색어로만 쓰고, description에는 이미지에 실제로 보이는 것만 쓴다.' : ''),
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
      search_keywords: Array.isArray(result.search_keywords) ? result.search_keywords.map(String).map((k: string) => k.trim()).filter(Boolean).slice(0, 30) : [],
      confidence_note: String(result.confidence_note ?? ''),
      source_sha256: sourceSha256,
      model: this.model,
      style_features: result.style_features && typeof result.style_features === 'object' ? result.style_features : {},
      scene_content: result.scene_content && typeof result.scene_content === 'object' ? result.scene_content : {},
    };
  }
}
