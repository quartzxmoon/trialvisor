export type ProviderSupport='GUIDED'|'NOT_SUPPORTED';
export type GmailMessage={id:string;threadId:string;internalDate?:string;snippet?:string;payload?:{headers?:Array<{name:string;value:string}>;body?:{data?:string};parts?:Array<{mimeType?:string;body?:{data?:string};parts?:unknown[]}>}};

const CANVA_CANCEL_URL='https://www.canva.com/help/cancel-canva-plan/';
const decodeB64Url=(s:string)=>{try{return new TextDecoder().decode(Uint8Array.from(atob(s.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0)))}catch{return''}};
const plainText=(value:string)=>value.replace(/<style[\s\S]*?<\/style>/gi,' ').replace(/<script[\s\S]*?<\/script>/gi,' ').replace(/<br\s*\/?>/gi,'\n').replace(/<\/p>/gi,'\n').replace(/<[^>]+>/g,' ').replace(/&nbsp;/gi,' ').replace(/&amp;/gi,'&').replace(/&lt;/gi,'<').replace(/&gt;/gi,'>').replace(/&#39;/g,"'").replace(/&quot;/gi,'"');

export const providerSupport=(provider:string):{support:ProviderSupport;tier:'3';cancellationUrl?:string}=>/\bcanva\b/i.test(provider)?{support:'GUIDED',tier:'3',cancellationUrl:CANVA_CANCEL_URL}:{support:'NOT_SUPPORTED',tier:'3'};

const messageText=(m:GmailMessage)=>{
 const headers=m.payload?.headers||[],header=(name:string)=>headers.find(h=>h.name.toLowerCase()===name)?.value||'';
 const plain:string[]=[],html:string[]=[];
 const walk=(part:any)=>{if(part?.body?.data){const decoded=decodeB64Url(part.body.data);if(part.mimeType==='text/plain')plain.push(decoded);else if(part.mimeType==='text/html')html.push(plainText(decoded))}for(const child of part?.parts||[])walk(child)};
 walk(m.payload);
 return{subject:header('subject').trim(),from:header('from').trim(),authenticationResults:headers.filter(h=>h.name.toLowerCase()==='authentication-results').map(h=>h.value).join(' '),text:(plain.join(' ')||html.join(' ')||m.snippet||'').replace(/\s+/g,' ').slice(0,16000)};
};

export const canvaCancellationEvidence=(m:GmailMessage)=>{const value=messageText(m),isCanvaDomain=(domain:string)=>domain==='canva.com'||domain.endsWith('.canva.com'),cleanDomain=(raw:string)=>(raw.split('@').at(-1)||'').toLowerCase().replace(/[^a-z0-9.-].*$/,''),fromDomain=cleanDomain(value.from.match(/@([^>\s]+)/)?.[1]||''),dkimPassedCanva=value.authenticationResults.split(';').some(clause=>{if(!/\bdkim=pass\b/i.test(clause))return false;const domains=Array.from(clause.matchAll(/header\.(?:i|d)=@?([^;\s]+)/gi),x=>cleanDomain(x[1]));return domains.some(isCanvaDomain)}),completion=/\b(?:cancellation\s+(?:is\s+)?confirmed|(?:subscription|plan|membership)\s+(?:has\s+been|was|is)\s+cancel(?:l)?ed|you(?:'|’)ve\s+cancel(?:l)?ed)\b/i.test(value.subject+' '+value.text),instructional=/\b(?:how\s+to|steps?\s+to|if\s+you\s+(?:want|wish)\s+to|cancel\s+your\s+plan\?)\b/i.test(value.subject);return isCanvaDomain(fromDomain)&&dkimPassedCanva&&completion&&!instructional?{receivedAt:m.internalDate?new Date(Number(m.internalDate)).toISOString():new Date().toISOString()}:null};

export const extractProvider=(from:string)=>{const displayMatch=from.match(/^"?([^"<@]+)"?\s*</)?.[1]?.trim(),candidate=(displayMatch||'').replace(/\b(?:no[\s-]?reply|billing|support|team|notifications?|service|info)\b/gi,'').replace(/\s+/g,' ').trim();if(candidate&&candidate.length>1)return candidate.slice(0,80);const domainPart=(from.match(/@([^>\s]+)/)?.[1]||'').toLowerCase().replace(/[^a-z0-9.-].*$/,''),domainSegments=domainPart.split('.').filter(Boolean),label=domainSegments.length>=2?domainSegments[domainSegments.length-2]:domainSegments[0]||'',genericDomains=new Set(['gmail','googlemail','yahoo','hotmail','outlook','icloud','live','aol','proton','protonmail']);if(label&&!genericDomains.has(label))return (label.charAt(0).toUpperCase()+label.slice(1)).slice(0,80);const beforeAt=(from.split('@')[0]||'').replace(/[^a-zA-Z0-9\s]/g,' ').trim(),cleanedBefore=beforeAt.replace(/\b(?:no[\s-]?reply|billing|support|team)\b/gi,'').trim();if(cleanedBefore)return (cleanedBefore.charAt(0).toUpperCase()+cleanedBefore.slice(1)).slice(0,80);return 'Subscription'};

export const classifySignal=(m:GmailMessage)=>{
 const value=messageText(m),search=(value.subject+' '+value.text).replace(/\s+/g,' ');
 const trial=/\b(free\s+trial|trial\s+(?:has\s+)?started|trial\s+(?:ends?|expires?|ending)|trial\s+period|after\s+(?:the|your)\s+trial)\b/i.test(search);
 const billing=/\b(will\s+be\s+charged|subscription|membership|renews?|renewal|next\s+(?:payment|billing)|upcoming\s+(?:charge|payment)|billing\s+date)\b/i.test(search);
 const price=search.match(/(?:USD\s*)?\$\s?(\d{1,5}(?:[.,]\d{2})?)/i);
 const namedDate=search.match(/\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2}(?:,\s*\d{4})?\b/i);
 const numericDate=search.match(/\b(?:\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4})\b/);
 const date=namedDate||numericDate,score=(trial?2:0)+(billing?1:0)+(price?1:0)+(date?1:0);
 if(score<1)return null;
 const confidence=score>=4?.94:score>=2?.74:.44,band:'HIGH'|'MEDIUM'|'LOW'=score>=4?'HIGH':score>=2?'MEDIUM':'LOW';
 const received=m.internalDate?new Date(Number(m.internalDate)):new Date();let parsed:Date|null=null;
 if(date){const raw=date[0],hasYear=/\b\d{4}\b/.test(raw);parsed=new Date(hasYear?raw:raw+', '+received.getUTCFullYear());if(!hasYear&&parsed.getTime()<received.getTime()-30*86400000)parsed=new Date(raw+', '+(received.getUTCFullYear()+1));if(Number.isNaN(parsed.getTime()))parsed=null}
 const end=parsed||new Date(received.getTime()+7*86400000),deadline=new Date(end.getTime()-48*3600000);
 const provider=extractProvider(value.from);
 return{provider,plan:value.subject.slice(0,120)||'Detected subscription',price:price?Number(price[1].replace(',','.')):0,currency:'USD',trialEnd:end.toISOString(),safeDeadline:deadline.toISOString(),plannedExecution:new Date(deadline.getTime()-3600000).toISOString(),state:'REVIEW_REQUIRED' as const,...providerSupport(provider),confidence,confidenceBand:band,sourceRef:{provider:'google' as const,messageId:m.id,threadId:m.threadId,receivedAt:m.internalDate?new Date(Number(m.internalDate)).toISOString():undefined}};
};
