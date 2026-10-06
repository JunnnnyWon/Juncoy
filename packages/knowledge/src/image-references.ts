import { DomainError } from '@meeting/domain';

export interface StoredImageReference {
  id: string;
  mime: string;
  state: string;
  asset_id?: string | null;
  asset_state?: string | null;
  canonical_state?: string | null;
}

/** DB row order is undefined; provider inputs must follow the approved list. */
export function orderedImageReferences<T extends StoredImageReference>(ids: string[], fetched: T[]): T[] {
  if (ids.length > 16 || new Set(ids).size !== ids.length)
    throw new DomainError('INVALID_REFERENCES', '레퍼런스는 중복 없이 최대 16개까지 사용할 수 있습니다.', 400);
  const byId = new Map(fetched.map((ref) => [ref.id, ref]));
  return ids.map((id) => {
    const ref = byId.get(id);
    if (!ref) throw new DomainError('REFERENCE_NOT_FOUND', '이미지 레퍼런스를 찾을 수 없습니다.', 409);
    if (ref.state !== 'READY' || !['image/png', 'image/jpeg', 'image/webp'].includes(ref.mime))
      throw new DomainError('REFERENCE_NOT_READY', '준비되지 않은 이미지 레퍼런스가 포함되어 있습니다.', 409);
    if (ref.asset_id && (ref.asset_state !== 'READY' || ['REJECTED', 'ARCHIVED'].includes(ref.canonical_state ?? '')))
      throw new DomainError('REFERENCE_UNAVAILABLE', '사용이 중단된 아트 자산입니다.', 409);
    return ref;
  });
}
