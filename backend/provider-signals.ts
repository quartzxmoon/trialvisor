export type ProviderSupport='GUIDED'|'NOT_SUPPORTED';
export type GmailMessage={id:string;threadId:string;internalDate?:string;snippet?:string;payload?:{headers?:Array<{name:string;value:string}>;body?:{data?:string};parts?:Array<{mimeType?:string;body?:{data?:string};parts?:unknown[]}>}};

const CANVA_CANCEL_URL='https://www.canva.com/help/cancel-canva-plan/';
const decodeB64Url=(s:string)=>{try{return new TextDecoder().decode(Uint8Array.from(atob(s.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0)))}catch{return''}};
const plainText=(value:string)=>value.replace(/<style[\s\S]*?<\/style>/gi,' ').replace(/<script[\s\S]*?<\/script>/gi,' ').replace(/<br\s*\/?>/gi,'\n').replace(/<\/p>/gi,'\n').replace(/<[^>]+>/g,' ').replace(/&nbsp;/gi,' ').replace(/&amp;/gi,'&').replace(/&lt;/gi,'<').replace(/&gt;/gi,'>').replace(/&#39;/g,"'").replace(/&quot;/gi,'"');

export const providerSupport=(provider:string):{support:ProviderSupport;tier:'3';cancellationUrl?:string}=>/\bcanva\b/i.test(provider)?{support:'GUIDED',tier:'3',cancellationUrl:CANVA_CANCEL_URL}:{support:'NOT_SUPPORTED',tier:'3'};
export const nextHistoryCheckpoint=(profileHistoryId:string,priorHistoryId:string|undefined,fetchFailures:number)=>fetchFailures>0?(priorHistoryId||''):profileHistoryId;

const messageText=(m:GmailMessage)=>{
 const headers=m.payload?.headers||[],header=(name:string)=>headers.find(h=>h.name.toLowerCase()===name)?.value||'';
 const plain:string[]=[],html:string[]=[];
 const walk=(part:any)=>{if(part?.body?.data){const decoded=decodeB64Url(part.body.data);if(part.mimeType==='text/plain')plain.push(decoded);else if(part.mimeType==='text/html')html.push(plainText(decoded))}for(const child of part?.parts||[])walk(child)};
 walk(m.payload);
 return{subject:header('subject').trim(),from:header('from').trim(),authenticationResults:headers.filter(h=>h.name.toLowerCase()==='authentication-results').map(h=>h.value).join(' '),listUnsubscribe:header('list-unsubscribe'),precedence:header('precedence'),text:(plain.join(' ')||html.join(' ')||m.snippet||'').replace(/\s+/g,' ').slice(0,16000)};
};

export const canvaCancellationEvidence=(m:GmailMessage)=>{const value=messageText(m),isCanvaDomain=(domain:string)=>domain==='canva.com'||domain.endsWith('.canva.com'),cleanDomain=(raw:string)=>(raw.split('@').at(-1)||'').toLowerCase().replace(/[^a-z0-9.-].*$/,''),fromDomain=cleanDomain(value.from.match(/@([^>\s]+)/)?.[1]||''),dkimPassedCanva=value.authenticationResults.split(';').some(clause=>{if(!/\bdkim=pass\b/i.test(clause))return false;const domains=Array.from(clause.matchAll(/header\.(?:i|d)=@?([^;\s]+)/gi),x=>cleanDomain(x[1]));return domains.some(isCanvaDomain)}),completion=/\b(?:cancellation\s+(?:is\s+)?confirmed|(?:subscription|plan|membership)\s+(?:has\s+been|was|is)\s+cancel(?:l)?ed|you(?:'|’)ve\s+cancel(?:l)?ed)\b/i.test(value.subject+' '+value.text),instructional=/\b(?:how\s+to|steps?\s+to|if\s+you\s+(?:want|wish)\s+to|cancel\s+your\s+plan\?)\b/i.test(value.subject);return isCanvaDomain(fromDomain)&&dkimPassedCanva&&completion&&!instructional?{receivedAt:m.internalDate?new Date(Number(m.internalDate)).toISOString():new Date().toISOString()}:null};

export const extractProvider=(from:string)=>{const displayMatch=from.match(/^"?([^"<@]+)"?\s*</)?.[1]?.trim(),candidate=(displayMatch||'').replace(/\b(?:no[\s-]?reply|billing|support|team|notifications?|service|info)\b/gi,'').replace(/\s+/g,' ').trim();if(candidate&&candidate.length>1)return candidate.slice(0,80);const domainPart=(from.match(/@([^>\s]+)/)?.[1]||'').toLowerCase().replace(/[^a-z0-9.-].*$/,''),domainSegments=domainPart.split('.').filter(Boolean),label=domainSegments.length>=2?domainSegments[domainSegments.length-2]:domainSegments[0]||'',genericDomains=new Set(['gmail','googlemail','yahoo','hotmail','outlook','icloud','live','aol','proton','protonmail']);if(label&&!genericDomains.has(label))return (label.charAt(0).toUpperCase()+label.slice(1)).slice(0,80);const beforeAt=(from.split('@')[0]||'').replace(/[^a-zA-Z0-9\s]/g,' ').trim(),cleanedBefore=beforeAt.replace(/\b(?:no[\s-]?reply|billing|support|team)\b/gi,'').trim();if(cleanedBefore)return (cleanedBefore.charAt(0).toUpperCase()+cleanedBefore.slice(1)).slice(0,80);return 'Subscription'};

const MONTH_MAP: Record<string, number> = {
  jan: 1, january: 1,
  feb: 2, february: 2,
  mar: 3, march: 3,
  apr: 4, april: 4,
  may: 5,
  jun: 6, june: 6,
  jul: 7, july: 7,
  aug: 8, august: 8,
  sep: 9, september: 9,
  oct: 10, october: 10,
  nov: 11, november: 11,
  dec: 12, december: 12,
};

export const formatCalendarDate = (
  s?: string,
  options?: Intl.DateTimeFormatOptions,
  locale: string = 'en-US'
): string => {
  if (!s) return '';
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) {
    const [, y, mon, d] = m;
    const local = new Date(Number(y), Number(mon) - 1, Number(d), 12, 0, 0);
    return local.toLocaleDateString(locale, options || { month: 'short', day: 'numeric' });
  }
  return new Date(s).toLocaleDateString(locale, options || { month: 'short', day: 'numeric' });
};

export type ExtractedDateSignal = {
  providerTrialEndDate?: string;
  trialEnd?: string;
  safeDeadline?: string;
  plannedExecution?: string;
  hasExplicitTime: boolean;
};

const RENEWAL_DATE_CONTEXT = /\b(?:trial\s+(?:ends?|expires?|ending|expiration)|after\s+(?:the|your)\s+trial|renews?(?:\s+on)?|renewal\s+date|next\s+(?:billing|payment|charge)\s+(?:date|on)?|upcoming\s+(?:charge|payment|billing)|will\s+be\s+charged\s+(?:on)?|billed\s+(?:on)?|auto(?:matically)?-renews?(?:\s+on)?)\b/i;

const isDateInRenewalContext = (search: string, matchIndex: number, matchLen: number): boolean => {
  const start = Math.max(0, matchIndex - 80);
  const end = Math.min(search.length, matchIndex + matchLen + 40);
  const snippet = search.slice(start, end);
  return RENEWAL_DATE_CONTEXT.test(snippet);
};

export const extractDateSignal = (search: string, received: Date, requireContext: boolean = true): ExtractedDateSignal => {
  // 1. Check for ISO timestamp with explicit time: YYYY-MM-DDTHH:mm(:ss)?(Z|[+-]HH:mm)?
  const isoMatch = search.match(/\b(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?\b/i);
  if (isoMatch && (!requireContext || isDateInRenewalContext(search, isoMatch.index || 0, isoMatch[0].length))) {
    const isoDate = new Date(isoMatch[0]);
    if (!isNaN(isoDate.getTime())) {
      const trialEnd = isoDate.toISOString();
      const deadline = new Date(isoDate.getTime() - 48 * 3600000).toISOString();
      const planned = new Date(new Date(deadline).getTime() - 3600000).toISOString();
      return {
        providerTrialEndDate: isoMatch[1],
        trialEnd,
        safeDeadline: deadline,
        plannedExecution: planned,
        hasExplicitTime: true
      };
    }
  }

  // 2. Check for named month date with optional explicit time:
  const namedMatch = search.match(/\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{1,2})(?:,\s*(\d{4}))?(?:\s+(?:at|@)\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?(?:\s+([A-Z]{3,4}|[+-]\d{2}:?\d{2}))?)?\b/i);
  if (namedMatch && (!requireContext || isDateInRenewalContext(search, namedMatch.index || 0, namedMatch[0].length))) {
    const mon = MONTH_MAP[namedMatch[1].toLowerCase()];
    const day = parseInt(namedMatch[2], 10);
    let year = namedMatch[3] ? parseInt(namedMatch[3], 10) : received.getUTCFullYear();
    if (!namedMatch[3]) {
      const candidate = new Date(Date.UTC(year, mon - 1, day));
      if (candidate.getTime() < received.getTime() - 30 * 86400000) {
        year += 1;
      }
    }
    const dateStr = year + '-' + String(mon).padStart(2, '0') + '-' + String(day).padStart(2, '0');
    if (namedMatch[4] && namedMatch[5]) {
      let hours = parseInt(namedMatch[4], 10);
      const mins = parseInt(namedMatch[5], 10);
      const secs = namedMatch[6] ? parseInt(namedMatch[6], 10) : 0;
      const ampm = namedMatch[7] ? namedMatch[7].toLowerCase() : null;
      if (ampm === 'pm' && hours < 12) hours += 12;
      if (ampm === 'am' && hours === 12) hours = 0;
      const dt = new Date(Date.UTC(year, mon - 1, day, hours, mins, secs));
      const trialEnd = dt.toISOString();
      const deadline = new Date(dt.getTime() - 48 * 3600000).toISOString();
      const planned = new Date(new Date(deadline).getTime() - 3600000).toISOString();
      return {
        providerTrialEndDate: dateStr,
        trialEnd,
        safeDeadline: deadline,
        plannedExecution: planned,
        hasExplicitTime: true
      };
    }
    // Date-only: conservative internal cutoff at start of calendar day in UTC (00:00:00.000Z)
    const cutoff = new Date(Date.UTC(year, mon - 1, day, 0, 0, 0));
    const deadline = new Date(cutoff.getTime() - 48 * 3600000).toISOString();
    const planned = new Date(new Date(deadline).getTime() - 3600000).toISOString();
    return {
      providerTrialEndDate: dateStr,
      trialEnd: cutoff.toISOString(),
      safeDeadline: deadline,
      plannedExecution: planned,
      hasExplicitTime: false
    };
  }

  // 3. Check for numeric date YYYY-MM-DD
  const isoDateOnly = search.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (isoDateOnly && (!requireContext || isDateInRenewalContext(search, isoDateOnly.index || 0, isoDateOnly[0].length))) {
    const y = parseInt(isoDateOnly[1], 10), m = parseInt(isoDateOnly[2], 10), d = parseInt(isoDateOnly[3], 10);
    const dateStr = y + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0');
    const cutoff = new Date(Date.UTC(y, m - 1, d, 0, 0, 0));
    const deadline = new Date(cutoff.getTime() - 48 * 3600000).toISOString();
    const planned = new Date(new Date(deadline).getTime() - 3600000).toISOString();
    return {
      providerTrialEndDate: dateStr,
      trialEnd: cutoff.toISOString(),
      safeDeadline: deadline,
      plannedExecution: planned,
      hasExplicitTime: false
    };
  }

  // 4. Check for slash date MM/DD/YYYY
  const slashDate = search.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{2,4})\b/);
  if (slashDate && (!requireContext || isDateInRenewalContext(search, slashDate.index || 0, slashDate[0].length))) {
    let m = parseInt(slashDate[1], 10), d = parseInt(slashDate[2], 10), y = parseInt(slashDate[3], 10);
    if (y < 100) y += 2000;
    const dateStr = y + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0');
    const cutoff = new Date(Date.UTC(y, m - 1, d, 0, 0, 0));
    const deadline = new Date(cutoff.getTime() - 48 * 3600000).toISOString();
    const planned = new Date(new Date(deadline).getTime() - 3600000).toISOString();
    return {
      providerTrialEndDate: dateStr,
      trialEnd: cutoff.toISOString(),
      safeDeadline: deadline,
      plannedExecution: planned,
      hasExplicitTime: false
    };
  }

  // 5. If no contextual date found, do NOT synthesize a deadline
  return {
    providerTrialEndDate: undefined,
    trialEnd: undefined,
    safeDeadline: undefined,
    plannedExecution: undefined,
    hasExplicitTime: false
  };
};

export type SignalKind = 'ACTIVE' | 'POSSIBLE' | 'PROMOTIONAL';
export type EnrollmentStatus = 'ACTIVE' | 'POSSIBLE' | 'PROMOTIONAL';
export type ExposureStatus = 'CONFIRMED' | 'UNCONFIRMED' | 'EXCLUDED';
export type SourceReference = { provider: 'google' | 'microsoft'; messageId: string; threadId: string; receivedAt?: string; accountIdentifier?: string };

export type DetectedSignal = {
  provider: string;
  plan: string;
  price: number;
  currency: string;
  billingCadence: 'monthly' | 'annual' | 'unknown';
  providerSubscriptionId?: string;
  trialEnd?: string;
  safeDeadline?: string;
  plannedExecution?: string;
  providerTrialEndDate?: string;
  hasExplicitTime: boolean;
  hasDetectedChargeDate: boolean;
  state: 'REVIEW_REQUIRED';
  support: ProviderSupport;
  tier: '3';
  cancellationUrl?: string;
  confidence: number;
  confidenceBand: 'HIGH' | 'MEDIUM' | 'LOW';
  enrollmentStatus: 'ACTIVE' | 'POSSIBLE' | 'PROMOTIONAL';
  exposureStatus: 'CONFIRMED' | 'UNCONFIRMED' | 'EXCLUDED';
  protectEligible: boolean;
  classificationReason: string;
  kind?: SignalKind;
  sourceRef: SourceReference;
};

export type MessageClassification = {
  classification: EnrollmentStatus;
  reason: string;
  provider: string;
  signal: DetectedSignal | null;
};

export const isPromotionalContent = (subject: string, text: string): boolean => {
  const combined = (subject + ' ' + text).toLowerCase();

  // 1. Price drops / shopping / droplist
  if (/\b(?:price\s+drop(?:s)?|droplist(?:ed)?|item\s+you\s+(?:droplisted|saved)|back\s+in\s+stock|abandoned\s+cart|left\s+in\s+your\s+cart|items?\s+in\s+your\s+cart)\b/i.test(combined)) {
    return true;
  }

  // 2. Retail deals, coupons, promo codes, discounts, seasonal marketing
  if (/\b(?:promo\s+code|coupon\s+code|discount\s+code|use\s+code\s+[a-z0-9_-]+|clearance\s+sale|flash\s+sale|deals?\s+of\s+the\s+day|special\s+deals?|save\s+\d+%\s+off|summer\s+deals?|save\s+big\s+on)\b/i.test(combined)) {
    return true;
  }

  // 3. Telecom / Carrier switch offers & hardware promotions
  if (/\b(?:switch\s+(?:and\s+save|to\s+[a-z]+|carriers?|your\s+phone)|when\s+you\s+switch|switch\s+today)\b/i.test(combined)) {
    return true;
  }
  if (/\b(?:trade-?in\s+(?:credit|value|offer|deal)|trade\s+your\s+phone|trade\s+in\s+and\s+save)\b/i.test(combined)) {
    return true;
  }
  if (/\b(?:visa\s+(?:prepaid\s+)?card|gift\s+card|prepaid\s+card|cashback\s+bonus|rebate\s+card|reward\s+card)\b/i.test(combined)) {
    return true;
  }
  if (/\b(?:save\s+up\s+to\s+\$[\d,]+|get\s+(?:a\s+)?\$[\d,]+\s+(?:visa|gift|card|credit|off)|up\s+to\s+\$[\d,]+\s+off)\b/i.test(combined)) {
    return true;
  }
  if (/\b(?:on\s+us\b|samsung\s+s\d+|free\s+5g\s+phone|hardware\s+promot(?:ion)?|bundle\s+offer|retention\s+offer|upgrade\s+offer)\b/i.test(combined)) {
    return true;
  }

  // 4. Marketing invitation CTAs (inviting user to start/try, NOT confirming enrollment)
  const isMarketingCta = /\b(?:start\s+your\s+(?:free\s+)?trial\s*(?:today|now)?|try\s+(?:it\s+)?free\s+for\s+\d+\s+days|try\s+[a-z0-9]+\s+free|claim\s+your\s+(?:free\s+)?trial|unlock\s+your\s+(?:free\s+)?trial|get\s+\d+\s+months\s+free|enjoy\s+\d+\s+months\s+free|give\s+[a-z0-9]+\s+a\s+try|special\s+offer\s+inside|limited\s+time\s+offer)\b/i.test(combined);
  const isEnrollmentConfirmed = /\b(?:your\s+(?:free\s+)?trial\s+(?:has\s+)?started|welcome\s+to\s+your\s+(?:free\s+)?trial|your\s+(?:free\s+)?trial\s+is\s+(?:now\s+)?active|thanks\s+for\s+starting\s+your\s+trial|subscription\s+confirmed|receipt\s+for\s+your\s+subscription)\b/i.test(combined);

  if (isMarketingCta && !isEnrollmentConfirmed) {
    return true;
  }

  return false;
};

export const extractRecurringPrice = (text: string): number => {
  const clean = text.replace(/\s+/g, ' ');

  // 1. Recurring cadence like "$14.99/month", "$14.99 per month", "$99 / year"
  const cadenceMatch = clean.match(/(?:\$\s*|\bUSD\s*)(\d{1,3}(?:,\d{3})*(?:\.\d{2})?|\d+(?:\.\d{2})?)\s*(?:\/|\s*(?:per|a|every)\s*)(month|mo|year|yr|week|quarter)\b/i);
  if (cadenceMatch) {
    const rawVal = cadenceMatch[1].replace(/,/g, '');
    const num = parseFloat(rawVal);
    const idx = cadenceMatch.index ?? 0; const nextWords = clean.slice(idx + cadenceMatch[0].length, idx + cadenceMatch[0].length + 20);
    if (!/\b(?:off|discount|credit|save|savings)\b/i.test(nextWords)) {
      if (!isNaN(num) && num > 0) return num;
    }
  }

  // 2. "charged $14.99" or "will be charged $14.99" or "renews at $14.99"
  const chargeMatch = clean.match(/\b(?:will\s+be\s+charged|charged|renews?\s+at|billed\s+at|next\s+charge\s+(?:of|is)|upcoming\s+(?:charge|payment)\s+(?:of|is))\s+(?:\$\s*|\bUSD\s*)(\d{1,3}(?:,\d{3})*(?:\.\d{2})?|\d+(?:\.\d{2})?)/i);
  if (chargeMatch) {
    const rawVal = chargeMatch[1].replace(/,/g, '');
    const num = parseFloat(rawVal);
    const idx = chargeMatch.index ?? 0; const nextWords = clean.slice(idx + chargeMatch[0].length, idx + chargeMatch[0].length + 20);
    if (!/\b(?:off|discount|credit|save|savings|gift|card)\b/i.test(nextWords)) {
      if (!isNaN(num) && num > 0) return num;
    }
  }

  // 3. "$14.99 after your trial"
  const afterTrialMatch = clean.match(/(?:\$\s*|\bUSD\s*)(\d{1,3}(?:,\d{3})*(?:\.\d{2})?|\d+(?:\.\d{2})?)\s*(?:after\s+(?:your\s+|the\s+)?trial)/i);
  if (afterTrialMatch) {
    const rawVal = afterTrialMatch[1].replace(/,/g, '');
    const num = parseFloat(rawVal);
    if (!isNaN(num) && num > 0) return num;
  }

  // 4. "$14.99 monthly" or "$14.99 annually"
  const freqMatch = clean.match(/(?:\$\s*|\bUSD\s*)(\d{1,3}(?:,\d{3})*(?:\.\d{2})?|\d+(?:\.\d{2})?)\s*(?:monthly|annually|yearly|each\s+month)\b/i);
  if (freqMatch) {
    const rawVal = freqMatch[1].replace(/,/g, '');
    const num = parseFloat(rawVal);
    if (!isNaN(num) && num > 0) return num;
  }

  return 0;
};

const promotionalIntent = /\b(?:start\s+(?:your\s+)?free\s+trial|try\s+[\w&+.-]+(?:\s+[\w&+.-]+){0,3}\s+free|(?:get|enjoy)\s+(?:up\s+to\s+)?\d+\s+months?\s+free|get\s+(?:a\s+)?free\s+(?:(?:phone|mobile)\s+)?line|claim\s+(?:this|your|the)\s+offer|upgrade\s+(?:today|now)|activate\s+(?:today|now)|sign\s+up\s+(?:today|now)|shop\s+now|special\s+offer|offer\s+for\s+you|you(?:'|’)re\s+eligible\s+for|limited[- ]time\s+(?:offer|deal)|bundle\s+(?:offer|deal)|retention\s+offer|come\s+back\s+(?:and|to)|we\s+miss\s+you|stay\s+and\s+save|save\s+(?:up\s+to\s+)?(?:\$\d+|\d+%)|\d+%\s+off|discount\s+(?:offer|code))\b/i;
const completedEnrollment = /\b(?:your\s+(?:free\s+)?trial\s+(?:has\s+)?started|your\s+(?:[\w&+.-]+\s+){0,4}(?:subscription|membership|plan)\s+is\s+(?:now\s+)?active|thanks\s+for\s+(?:subscribing|joining|starting\s+your\s+trial)|you(?:'|’)re\s+(?:now\s+)?subscribed|welcome\s+to\s+(?:your\s+)?[\w&+.-]+(?:\s+[\w&+.-]+){0,4}\s+(?:plan|membership|subscription))\b/i;
const ownedTrialEnd = /\b(?:your\s+(?:[\w&+.-]+\s+){0,4}(?:free\s+)?trial\s+(?:ends?|expires?|is\s+ending)|after\s+your\s+trial[,. ]+you\s+will\s+be\s+charged|you\s+will\s+be\s+charged\s+(?:USD\s*)?\$\s?\d[^.]{0,80}\s+after\s+your\s+trial)\b/i;
const activeRenewal = /\b(?:your\s+(?:current\s+)?(?:[\w&+.-]+\s+){0,4}(?:subscription|membership|plan)\s+(?:renews?|will\s+renew)|renewal\s+(?:notice|date|reminder)\s+for\s+your|your\s+next\s+(?:renewal|billing)\s+(?:date|charge))\b/i;
const activeBilling = /\b(?:(?:invoice|payment|amount)\s+(?:is\s+)?due|upcoming\s+(?:charge|payment)\s+for\s+your|we\s+will\s+charge\s+your|your\s+(?:card|payment\s+method)\s+will\s+be\s+charged)\b/i;
const transactionReceipt = /\b(?:receipt\s+for\s+your|payment\s+(?:received|successful|confirmed)|we\s+charged\s+(?:your|the)|thanks\s+for\s+your\s+payment|subscription\s+payment\s+receipt)\b/i;
const weakOwnership = /\b(?:your\s+(?:plan|subscription|membership|account)|manage\s+(?:your\s+)?(?:plan|subscription|membership)|subscription\s+(?:update|details|information)|billing\s+(?:details|information))\b/i;
const signalLanguage = /\b(?:free\s+trial|trial\s+(?:period|ends?|expires?|started)|subscription|membership|renewal|billing|invoice|receipt|payment|charged)\b/i;
const datePattern = /\b(?:(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2}(?:,\s*\d{4})?|\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4})\b/i;
const entityWords = new Set(['your','free','trial','has','started','start','ends','end','ending','expires','subscription','membership','confirmation','reminder','renewal','billing','payment','receipt','will','be','charged','after','on','active','notice','welcome','thanks','for','the','plan','update','upcoming']);
export const normalizedEntityPlan = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter(x => x.length > 1 && !entityWords.has(x)).slice(0, 8).join(' ');
const planName = (subject: string, provider: string) => {
  const explicit = subject.match(/(?:your|welcome\s+to)\s+([a-z0-9][a-z0-9 &+.-]{1,60}?)\s+(?:free\s+trial|trial|subscription|membership|plan)\b/i)?.[1]?.trim();
  return explicit || normalizedEntityPlan(subject) || provider + ' subscription';
};

export const classifyMessage = (m: GmailMessage): MessageClassification | null => {
  const value = messageText(m);
  const search = (value.subject + ' ' + value.text).replace(/\s+/g, ' ').trim();
  const provider = extractProvider(value.from);

  const promo = isPromotionalContent(value.subject, value.text) || promotionalIntent.test(search);
  const enrolled = completedEnrollment.test(search);
  const trialEnd = ownedTrialEnd.test(search);
  const renewal = activeRenewal.test(search);
  const billing = activeBilling.test(search);
  const receipt = transactionReceipt.test(search);
  const weak = weakOwnership.test(search);
  const hasSignal = signalLanguage.test(search);
  const marketingHeader = !!value.listUnsubscribe || /\b(?:bulk|list|junk)\b/i.test(value.precedence);
  const strong = enrolled || trialEnd || renewal || receipt || billing;

  if (!hasSignal && !promo && !weak) return null;

  if ((promo || marketingHeader) && !strong) {
    return {
      classification: 'PROMOTIONAL',
      reason: 'Offer or bulk-marketing language without evidence that the user enrolled.',
      provider,
      signal: null
    };
  }

  const status: EnrollmentStatus = (enrolled || trialEnd || renewal || billing || receipt) ? 'ACTIVE' : 'POSSIBLE';
  const received = m.internalDate ? new Date(Number(m.internalDate)) : new Date();
  const price = extractRecurringPrice(search);
  const dateSignal = extractDateSignal(search, received, true);

  const cadence: 'monthly' | 'annual' | 'unknown' =
    /\b(?:per\s+month|\/\s*month|monthly)\b/i.test(search) ? 'monthly' :
    /\b(?:per\s+year|\/\s*year|annually|annual|yearly)\b/i.test(search) ? 'annual' : 'unknown';

  const hasDetectedChargeDate = !!dateSignal.trialEnd && (trialEnd || renewal || billing || enrolled);
  const exposureConfirmed = status === 'ACTIVE' && hasDetectedChargeDate && price > 0 && !receipt;

  let confidence: number;
  if (status === 'ACTIVE') {
    confidence = enrolled && (trialEnd || renewal || billing) && price > 0 ? 0.96 :
                 (enrolled || trialEnd || renewal || billing || receipt) ? 0.86 : 0.78;
  } else {
    confidence = weak ? 0.58 : 0.42;
  }
  const band: 'HIGH' | 'MEDIUM' | 'LOW' = confidence >= 0.8 ? 'HIGH' : confidence >= 0.5 ? 'MEDIUM' : 'LOW';
  const subscriptionId = search.match(/\b(?:subscription|membership|plan)\s*(?:id|number|#)\s*[:#]?\s*([a-z0-9_-]{5,40})\b/i)?.[1];
  const reason = status === 'ACTIVE'
    ? (enrolled ? 'Completed enrollment language detected.' : trialEnd ? 'User-owned trial end language detected.' : renewal ? 'Active renewal language detected.' : billing ? 'Active billing language detected.' : 'Completed payment evidence supports enrollment.')
    : 'Subscription language needs user confirmation; enrollment is not proven.';

  // Invariant: For POSSIBLE signals, safeDeadline and plannedExecution MUST NOT be populated as authoritative
  const safeDeadline = status === 'ACTIVE' ? dateSignal.safeDeadline : undefined;
  const plannedExecution = status === 'ACTIVE' ? dateSignal.plannedExecution : undefined;
  const trialEndDate = status === 'ACTIVE' ? dateSignal.trialEnd : undefined;

  return {
    classification: status,
    reason,
    provider,
    signal: {
      provider,
      plan: planName(value.subject, provider),
      price,
      currency: 'USD',
      billingCadence: cadence,
      providerSubscriptionId: subscriptionId,
      trialEnd: trialEndDate,
      safeDeadline,
      plannedExecution,
      providerTrialEndDate: status === 'ACTIVE' ? dateSignal.providerTrialEndDate : undefined,
      hasExplicitTime: status === 'ACTIVE' ? dateSignal.hasExplicitTime : false,
      hasDetectedChargeDate,
      state: 'REVIEW_REQUIRED',
      ...providerSupport(provider),
      confidence,
      confidenceBand: band,
      enrollmentStatus: status,
      exposureStatus: exposureConfirmed ? 'CONFIRMED' : 'UNCONFIRMED',
      protectEligible: status === 'ACTIVE' && hasDetectedChargeDate && !!safeDeadline,
      classificationReason: reason,
      kind: status,
      sourceRef: {
        provider: 'google',
        messageId: m.id,
        threadId: m.threadId,
        receivedAt: m.internalDate ? new Date(Number(m.internalDate)).toISOString() : undefined
      }
    }
  };
};

export const classifySignal = (m: GmailMessage): DetectedSignal | null => {
  const res = classifyMessage(m);
  if (!res) return null;
  if (res.signal) return res.signal;
  if (res.classification === 'PROMOTIONAL') {
    const value = messageText(m);
    const provider = extractProvider(value.from);
    return {
      provider,
      plan: planName(value.subject, provider),
      price: 0,
      currency: 'USD',
      billingCadence: 'unknown',
      trialEnd: undefined,
      safeDeadline: undefined,
      plannedExecution: undefined,
      providerTrialEndDate: undefined,
      hasExplicitTime: false,
      hasDetectedChargeDate: false,
      state: 'REVIEW_REQUIRED',
      ...providerSupport(provider),
      confidence: 0.1,
      confidenceBand: 'LOW',
      enrollmentStatus: 'PROMOTIONAL',
      exposureStatus: 'EXCLUDED',
      protectEligible: false,
      classificationReason: res.reason,
      kind: 'PROMOTIONAL',
      sourceRef: {
        provider: 'google',
        messageId: m.id,
        threadId: m.threadId,
        receivedAt: m.internalDate ? new Date(Number(m.internalDate)).toISOString() : undefined
      }
    };
  }
  return null;
};

export type EntitySignal={provider:string;plan:string;price:number;billingCadence?:string;providerSubscriptionId?:string;providerTrialEndDate?:string;trialEnd?:string;hasDetectedChargeDate?:boolean;sourceRef?:SourceReference;supportingSourceRefs?:SourceReference[]};
export const sameSubscriptionEntity=(existing:EntitySignal,incoming:EntitySignal)=>{
 if(existing.sourceRef?.messageId&&existing.sourceRef.messageId===incoming.sourceRef?.messageId)return true;
 if(existing.sourceRef?.threadId&&existing.sourceRef.threadId===incoming.sourceRef?.threadId)return true;
 if(existing.provider.toLowerCase()!==incoming.provider.toLowerCase())return false;
 const a=existing.sourceRef?.accountIdentifier,b=incoming.sourceRef?.accountIdentifier;if(a&&b&&a!==b)return false;
 if(existing.providerSubscriptionId&&incoming.providerSubscriptionId)return existing.providerSubscriptionId===incoming.providerSubscriptionId;
 const planA=normalizedEntityPlan(existing.plan),planB=normalizedEntityPlan(incoming.plan),samePlan=!!planA&&!!planB&&(planA===planB||planA.includes(planB)||planB.includes(planA));
 const samePrice=existing.price>0&&incoming.price>0&&Math.abs(existing.price-incoming.price)<.01,cadenceCompatible=!existing.billingCadence||!incoming.billingCadence||existing.billingCadence==='unknown'||incoming.billingCadence==='unknown'||existing.billingCadence===incoming.billingCadence;
 const bothDated=!!existing.hasDetectedChargeDate&&!!incoming.hasDetectedChargeDate&&!!existing.trialEnd&&!!incoming.trialEnd,dateNear=!bothDated||Math.abs(new Date(existing.trialEnd!).getTime()-new Date(incoming.trialEnd!).getTime())<=14*86400000;
 return cadenceCompatible&&dateNear&&(samePlan&&(samePrice||bothDated)||samePrice&&bothDated);
};

export const mergeSourceReferences=(existing:EntitySignal,incoming:EntitySignal)=>{const refs=[...(existing.supportingSourceRefs||[]),...(existing.sourceRef?[existing.sourceRef]:[]),...(incoming.sourceRef?[incoming.sourceRef]:[])],seen=new Set<string>();return refs.filter(x=>{const key=x.provider+':'+x.messageId;if(seen.has(key))return false;seen.add(key);return true}).slice(-20)};

export type ExposureItem={price:number;trialEnd?:string;state:string;enrollmentStatus?:EnrollmentStatus;exposureStatus?:ExposureStatus;kind?:SignalKind;sourceRef?:SourceReference;authorizationAt?:string;userConfirmedEnrollmentAt?:string};
export const exposureSummary=(items:ExposureItem[],now=Date.now())=>{const eligible=items.filter(x=>!['CANCELED_CONFIRMED','KEEP_REQUESTED','DISMISSED'].includes(x.state)&&(x.enrollmentStatus||x.kind)==='ACTIVE'&&x.exposureStatus==='CONFIRMED'&&x.price>0&&!!x.trialEnd),within=(days:number)=>eligible.filter(x=>{const due=new Date(x.trialEnd!).getTime();return due>=now&&due<=now+days*86400000}).reduce((sum,x)=>sum+x.price,0),uncertain=items.filter(x=>!['CANCELED_CONFIRMED','KEEP_REQUESTED'].includes(x.state)&&x.enrollmentStatus==='POSSIBLE');return{confirmed7:within(7),confirmed30:within(30),uncertainCount:uncertain.length,uncertainAmount:uncertain.reduce((sum,x)=>sum+(x.price||0),0)}};
