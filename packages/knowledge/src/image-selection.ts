// One authoritative role/strength mapping. Legacy disagreement requires review.
export function normalizeReference(ref: any) {
  const roles: string[] = ref.roles?.length ? [...new Set<string>(ref.roles)] : [ref.role ?? 'mood'];
  const usage = ref.roleUsage ?? {};
  const conflict = Object.keys(usage).some(role => !roles.includes(role));
  return { ...ref, roles, roleUsage: Object.fromEntries(roles.map(role => [role, usage[role] ?? ref.usage ?? 'REVIEW_REQUIRED'])), review_required: conflict };
}
export function selectReferences(refs: any[], output: string, explicitUploadIds: string[] = []) {
  if (explicitUploadIds.length > 16 || new Set(explicitUploadIds).size !== explicitUploadIds.length)
    throw Object.assign(new Error('지정 원본은 중복 없이 최대 16개까지 사용할 수 있습니다.'), { code: 'REFERENCE_LIMIT', statusCode: 409 });
  const priorities: Record<string, string[]> = {
    character: ['modeling_language', 'face_shape', 'material_surface', 'texture'],
    background: ['material_surface', 'texture', 'lighting', 'mood'],
    ui: ['ui', 'hud', 'interface'],
    game_scene: ['modeling_language', 'material_surface', 'lighting', 'mood'],
  };
  const allowed = priorities[output] ?? priorities.game_scene;
  const candidates = refs.map(normalizeReference).filter(ref => !ref.review_required && (explicitUploadIds.includes(ref.upload_id) || ref.roles.some((role: string) => allowed.includes(role)))
    && !Object.values(ref.roleUsage).includes('REVIEW_REQUIRED'))
    .sort((a, b) => Math.min(...a.roles.map((r: string) => allowed.indexOf(r) < 0 ? 99 : allowed.indexOf(r)))
      - Math.min(...b.roles.map((r: string) => allowed.indexOf(r) < 0 ? 99 : allowed.indexOf(r))))
    ;
  if (explicitUploadIds.some(id => !candidates.some(ref => ref.upload_id === id)))
    throw Object.assign(new Error('지정한 원본 중 준비되지 않았거나 검토가 필요한 이미지가 있습니다.'), { code: 'REFERENCE_NOT_READY', statusCode: 409 });
  const explicit = explicitUploadIds.map(id => candidates.find(ref => ref.upload_id === id)!);
  return [...explicit, ...candidates.filter(ref => !explicitUploadIds.includes(ref.upload_id))]
    .slice(0, Math.max(6, explicit.length)).map(ref => ({ ...ref, purpose: ref.roles.join(', ') + ' 특성만 참고',
      reason: output + ' 요청과 관련된 역할', forbidden: ['인물 정체성', '의상', '행동', '장소', '카메라 구도'],
      note: (ref.roles.map((role: string) => role + ': ' + ref.roleUsage[role]).join('; ') + '. 사용자 참고 지시: ' + (ref.note?.startsWith('자동 분류:') ? '자동 관찰의 장면 내용은 계승하지 않음' : ref.note ?? '없음') + '. 해당 스타일 특성만 참고. 원본 인물·의상·행동·장소·구도를 복제하지 않는다.').slice(0, 2000) }));
}
