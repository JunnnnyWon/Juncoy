export function stripEvidenceMarkers(text:string) {
  // URLs, code and Markdown links may contain legitimate e-prefixed hashes.
  return text.split(/(`[^`]*`|\[[^\]]*\]\([^)]+\)|https?:\/\/\S+)/g).map((part,index)=> index%2 ? part : part.replace(/\[\s*e\d+(?:\s*,\s*e\d+)*\s*\]/gi,'').replace(/(?<![A-Za-z0-9_])\(?\s*e\d+(?:\s*,\s*e\d+)*\s*\)?(?![A-Za-z0-9_])/gi,'')).join('');
}
export function inlineMarkdown(text:string) {
  const literal=(value:string)=>value.replace(/\\([\\`*_{}\[\]<>#|])/g,'$1');
  return text.split(/((?<!\\)\*\*[^*]+\*\*|(?<!\\)`[^`]+`|(?<!\\)\[[^\]\n]+\]\((?:https?:\/\/|\/(?!\/))[^)\s]+\))/g).filter(Boolean).map(part=> {
    const link=part.match(/^\[([^\]]+)\]\((https?:\/\/[^\s)]+|\/(?!\/)[^\s)]+)\)$/);
    if(link) return {kind:'link',text:literal(link[1]!),url:link[2]!};
    if(part.startsWith('**')&&part.endsWith('**'))return {kind:'strong',text:literal(part.slice(2,-2))};
    if(part.startsWith('`')&&part.endsWith('`'))return {kind:'code',text:part.slice(1,-1)};
    return {kind:'text',text:literal(part)};
  });
}
