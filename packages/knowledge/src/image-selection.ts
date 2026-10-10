// One authoritative role/strength mapping. Legacy disagreement requires review.
export function normalizeReference(ref: any) {
  const roles: string[] = ref.roles?.length ? [...new Set<string>(ref.roles)] : [ref.role ?? 'mood'];
  const usage = ref.roleUsage ?? {};
  const conflict = Object.keys(usage).some(role => !roles.includes(role));
  return { ...ref, roles, roleUsage: Object.fromEntries(roles.map(role => [role, usage[role] ?? ref.usage ?? 'REVIEW_REQUIRED'])), review_required: conflict };
}
export function selectReferences(refs: any[], output: string) {
  const priorities: Record<string, string[]> = {
    character: ['modeling_language', 'face_shape', 'material_surface', 'texture'],
    background: ['material_surface', 'texture', 'lighting', 'mood'],
    ui: ['ui', 'hud', 'interface'],
    game_scene: ['modeling_language', 'material_surface', 'lighting', 'mood'],
  };
  const allowed = priorities[output] ?? priorities.game_scene;
  return refs.map(normalizeReference).filter(ref => !ref.review_required && ref.roles.some((role: string) => allowed.includes(role))
    && !Object.values(ref.roleUsage).includes('REVIEW_REQUIRED'))
    .sort((a, b) => Math.min(...a.roles.map((r: string) => allowed.indexOf(r) < 0 ? 99 : allowed.indexOf(r)))
      - Math.min(...b.roles.map((r: string) => allowed.indexOf(r) < 0 ? 99 : allowed.indexOf(r))))
    .slice(0, 6).map(ref => ({ ...ref, purpose: ref.roles.join(', ') + ' 특성만 참고',
      reason: output + ' 요청과 관련된 역할', forbidden: ['인물 정체성', '의상', '행동', '장소', '카메라 구도'],
      note: (ref.roles.map((role: string) => role + ': ' + ref.roleUsage[role]).join('; ') + '. 사용자 참고 지시: ' + (ref.note?.startsWith('자동 분류:') ? '자동 관찰의 장면 내용은 계승하지 않음' : ref.note ?? '없음') + '. 해당 스타일 특성만 참고. 원본 인물·의상·행동·장소·구도를 복제하지 않는다.').slice(0, 2000) }));
}
