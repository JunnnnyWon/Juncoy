import { cleanEvidenceText } from '@meeting/contracts';
export const stripEvidenceMarkers = cleanEvidenceText;
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
