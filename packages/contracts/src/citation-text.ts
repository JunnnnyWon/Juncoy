/** Remove presentation-only evidence IDs without changing code, links or array values. */
export function cleanEvidenceText(text:string):string {
  if (/^[\s]*[\[{]/.test(text)) { try { JSON.parse(text); return text; } catch { /* prose and evidence markers continue below */ } }
  return text.split(/(```[\s\S]*?```|`[^`]*`|\[[^\]]*\]\([^)]+\)|https?:\/\/\S+)/g).map((part,index)=> {
    if(index%2) return part;
    return part
      .replace(/\[\s*e\d+(?:\s*[,，]\s*e\d+)*\s*\]/gi,'')
      .replace(/\(\s*e\d+(?:\s*[,，]\s*e\d+)*\s*\)/gi,'')
      .replace(/(?<![A-Za-z0-9_])e\d+(?![A-Za-z0-9_])/gi,'')
      .replace(/[ \t]*\[\s*\](?=[ \t]*(?:[.!?。]|\n|$))/g,(marker:string,offset:number,whole:string)=> {
        const prefix=whole.slice(0,offset).split('\n').at(-1) ?? '';
        if(!/[\p{L}\p{N})]\s*$/u.test(prefix)) return marker;
        if(/(?:배열|array|list|반환값|return|JSON|값)\s*(?:은|는|:|=)?\s*$/iu.test(prefix)) return marker;
        return '';
      }).replace(/[ \t]+([.!?。])(?=\s|$)/g,'$1');
  }).join('');
}
