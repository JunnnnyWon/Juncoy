/** Short references are scoped to one provider request; canonical UUIDs never change. */
export function encodeEvidence(input: unknown, schema: unknown) {
  const ids = new Set<string>();
  const starts = new Map<string, number>();
  const collect = (value: any): void => {
    if (!value || typeof value !== 'object') return;
    if (typeof value.segment_id === 'string') ids.add(value.segment_id);
    if (typeof value.segment_id === 'string' && typeof value.start_ms === 'number')
      starts.set(value.segment_id, value.start_ms);
    for (const [key, item] of Object.entries(value))
      if (key.endsWith('evidence_segment_ids') && Array.isArray(item))
        item.forEach((id: string) => ids.add(id));
    Object.values(value).forEach(collect);
  };
  collect(input);
  const ordered = [...ids].sort(
    (a, b) => (starts.get(a) ?? Infinity) - (starts.get(b) ?? Infinity),
  );
  const forward = new Map(ordered.map((id, i) => [id, 's' + (i + 1)]));
  const reverse = new Map([...forward].map(([id, alias]) => [alias, id]));
  const encode = (value: any): any => {
    if (Array.isArray(value)) return value.map(encode);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        key === 'segment_id'
          ? forward.get(item as string)
          : key.endsWith('evidence_segment_ids')
            ? [...new Set((item as string[]).map((id) => forward.get(id)))]
            : encode(item),
      ]),
    );
  };
  const constrained = structuredClone(schema) as any;
  const constrain = (value: any): void => {
    if (!value || typeof value !== 'object') return;
    for (const [key, raw] of Object.entries(value.properties ?? {})) {
      if (!key.endsWith('evidence_segment_ids')) continue;
      const field = raw as any;
      if (reverse.size) {
        field.items = { type: 'string', enum: [...reverse.keys()] };
        field.minItems = key === 'evidence_segment_ids' ? 1 : 0;
        field.maxItems = 4;
      } else {
        field.maxItems = 0;
      }
    }
    Object.values(value).forEach(constrain);
  };
  constrain(constrained);
  const decode = (value: any): any => {
    if (Array.isArray(value)) return value.map(decode);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        key.endsWith('evidence_segment_ids') && Array.isArray(item)
          ? [
              ...new Set(
                item.map((alias) => {
                  const id = reverse.get(alias);
                  if (!id) throw new Error('UNKNOWN_EVIDENCE_ALIAS');
                  return id;
                }),
              ),
            ]
          : decode(item),
      ]),
    );
  };
  return { input: encode(input), schema: constrained, decode };
}

/** Await every in-flight call before a failure escapes to a job retry. */
export async function orderedBatches<T, R>(
  items: T[],
  limit: number,
  run: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const result: R[] = [];
  for (let i = 0; i < items.length; i += limit) {
    const batch = await Promise.allSettled(
      items.slice(i, i + limit).map((item, j) => run(item, i + j)),
    );
    const failure = batch.find((r) => r.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
    result.push(...batch.map((r) => (r as PromiseFulfilledResult<R>).value));
  }
  return result;
}
