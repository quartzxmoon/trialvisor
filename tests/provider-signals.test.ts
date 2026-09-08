import fs from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { canvaCancellationEvidence, classifyMessage, classifySignal, exposureSummary, extractProvider, formatCalendarDate, mergeSourceReferences, nextHistoryCheckpoint, sameSubscriptionEntity, isPromotionalContent, extractRecurringPrice, extractDateSignal, type GmailMessage } from '../backend/provider-signals.ts';

const encoded=(value:string)=>Buffer.from(value).toString('base64url');
const message=(subject:string,body:string,from:string,authenticationResults?:string):GmailMessage=>({
  id:'message-1',
  threadId:'thread-1',
  internalDate:String(Date.UTC(2026,8,1)),
  payload:{
    headers:[
      {name:'Subject',value:subject},
      {name:'From',value:from},
      ...(authenticationResults?[{name:'Authentication-Results',value:authenticationResults}]:[])
    ],
    parts:[{mimeType:'text/plain',body:{data:encoded(body)}}]
  }
});

test('normalizes usable sender domains into provider identities',()=>{
  assert.equal(extractProvider('no-reply@canva.com'),'Canva');
  assert.equal(extractProvider('billing@dropbox.com'),'Dropbox');
});

test('classifies the controlled Gmail message as one high-confidence review finding',()=>{
  const result=classifySignal(message(
    'Your free trial has started',
    'Your trial ends September 10, 2026. You will be charged $14.99/month after your trial.',
    'no-reply@canva.com'
  ));
  assert.ok(result);
  assert.equal(result.provider,'Canva');
  assert.equal(result.price,14.99);
  assert.equal(result.providerTrialEndDate,'2026-09-10');
  assert.equal(result.trialEnd,'2026-09-10T00:00:00.000Z');
  assert.equal(result.hasExplicitTime,false);
  assert.equal(result.safeDeadline,'2026-09-08T00:00:00.000Z');
  assert.equal(result.plannedExecution,'2026-09-07T23:00:00.000Z');
  assert.equal(result.confidenceBand,'HIGH');
  assert.equal(result.state,'REVIEW_REQUIRED');
  assert.equal(result.support,'GUIDED');
  assert.equal(result.enrollmentStatus,'ACTIVE');
  assert.equal(result.exposureStatus,'CONFIRMED');
  assert.equal(result.protectEligible,true);
});

test('keeps ambiguous ownership in review without Protect or confirmed exposure',()=>{
  const medium=classifySignal(message('Your subscription details','A plan may be associated with your account.','billing@dropbox.com'));
  const low=classifySignal(message('Subscription changes','Changes may apply.','billing@dropbox.com'));
  assert.equal(medium?.confidenceBand,'MEDIUM');
  assert.equal(low?.confidenceBand,'LOW');
  assert.equal(medium?.state,'REVIEW_REQUIRED');
  assert.equal(low?.state,'REVIEW_REQUIRED');
  assert.equal(medium?.enrollmentStatus,'POSSIBLE');
  assert.equal(medium?.exposureStatus,'UNCONFIRMED');
  assert.equal(medium?.protectEligible,false);
});

test('rejects promotional and offer-only messages as active enrollment',()=>{
  const negatives=[
    ['A free mobile line is waiting','Get a free mobile line with your Xfinity Internet. Claim your offer today.','offers@xfinity.com'],
    ['Start your free trial','Start your free trial today. Plans are $19.99/month after activation.','news@streamer.example'],
    ['Get 3 months free','Get 3 months free when you sign up today.','offers@music.example'],
    ['Upgrade today','Upgrade today to Premium for $14.99/month.','billing@dropbox.com'],
    ['We miss you','Come back and save 25% on Premium.','offers@service.example'],
    ['A discount for you','Special offer for you: 30% off any annual plan.','news@service.example'],
    ['Bundle and save','Bundle offer: add mobile service and save $20.','offers@xfinity.com'],
    ['Make more with Canva','Try Canva Pro free and upgrade today.','no-reply@canva.com']
  ];
  for(const [subject,body,from] of negatives){
    const result=classifyMessage(message(subject,body,from));
    assert.equal(result?.classification,'PROMOTIONAL',subject);
    assert.equal(result?.signal,null,subject);
  }
});

test('uses bulk-mail evidence to reject a known-provider advertisement without enrollment proof',()=>{
  const value=message('Explore Dropbox Premium','Discover new features. Subscription plans start at $11.99/month.','billing@dropbox.com');
  value.payload!.headers!.push({name:'List-Unsubscribe',value:'<https://dropbox.com/unsubscribe>'},{name:'Precedence',value:'bulk'});
  const result=classifyMessage(value);
  assert.equal(result?.classification,'PROMOTIONAL');
  assert.equal(result?.signal,null);
});

test('accepts strong enrollment, renewal, billing, and receipt evidence',()=>{
  const positives=[
    message('Your free trial has started','Your trial ends September 10, 2026. You will be charged $14.99/month after your trial.','no-reply@canva.com'),
    message('Your trial ends September 10','You will be charged $14.99/month after your trial.','billing@dropbox.com'),
    message('Subscription confirmation','Your Premium subscription is now active.','billing@dropbox.com'),
    message('Renewal reminder','Your membership renews September 18, 2026 for $9.99/month.','billing@service.example'),
    message('Invoice due September 18','Your invoice is due September 18, 2026. Amount $24.99.','billing@service.example'),
    message('Payment receipt','Payment received. Thanks for your payment of $12.00 for your subscription.','billing@service.example')
  ];
  for(const value of positives){
    const result=classifyMessage(value);
    assert.equal(result?.classification,'ACTIVE',value.payload?.headers?.[0]?.value);
    assert.equal(result?.signal?.state,'REVIEW_REQUIRED');
  }
});

test('resolves related provider evidence to one canonical entity without crossing accounts',()=>{
  const first=classifySignal(message('Your Canva Pro trial has started','Your trial ends September 10, 2026. You will be charged $14.99/month after your trial.','no-reply@canva.com'))!;
  const later={...classifySignal({...message('Your Canva Pro trial reminder','Your trial ends September 12, 2026. You will be charged $14.99/month after your trial.','no-reply@canva.com'),id:'message-2',threadId:'thread-2'})!};
  first.sourceRef.accountIdentifier='account-a';
  later.sourceRef.accountIdentifier='account-a';
  assert.equal(sameSubscriptionEntity(first,later),true);
  const refs=mergeSourceReferences(first,later);
  assert.equal(refs.length,2);
  assert.deepEqual(refs.map(x=>x.messageId),['message-1','message-2']);
  const replay=mergeSourceReferences({...first,supportingSourceRefs:refs},later);
  assert.equal(replay.length,2,'repeated sync must not duplicate source evidence');
  later.sourceRef.accountIdentifier='account-b';
  assert.equal(sameSubscriptionEntity(first,later),false,'separate inbox identities must not be merged');
});

test('does not over-deduplicate different providers or materially different plans',()=>{
  const canva=classifySignal(message('Your Canva Pro trial has started','Your trial ends September 10, 2026. You will be charged $14.99/month after your trial.','no-reply@canva.com'))!;
  const dropbox={...canva,provider:'Dropbox',sourceRef:{...canva.sourceRef,messageId:'message-2',threadId:'thread-2'}};
  const canvaTeams={...canva,plan:'Canva Teams',price:29.99,sourceRef:{...canva.sourceRef,messageId:'message-3',threadId:'thread-3'}};
  assert.equal(sameSubscriptionEntity(canva,dropbox),false);
  assert.equal(sameSubscriptionEntity(canva,canvaTeams),false);
});

test('confirmed exposure excludes promotions and separates ambiguous amounts',()=>{
  const now=Date.UTC(2026,8,1);
  const active={price:14.99,trialEnd:'2026-09-10T00:00:00.000Z',state:'REVIEW_REQUIRED',enrollmentStatus:'ACTIVE' as const,exposureStatus:'CONFIRMED' as const};
  const possible={price:1999,trialEnd:'2026-09-12T00:00:00.000Z',state:'REVIEW_REQUIRED',enrollmentStatus:'POSSIBLE' as const,exposureStatus:'UNCONFIRMED' as const};
  const promotional={price:999,trialEnd:'2026-09-05T00:00:00.000Z',state:'REVIEW_REQUIRED',enrollmentStatus:'PROMOTIONAL' as const,exposureStatus:'EXCLUDED' as const};
  const summary=exposureSummary([active,possible,promotional],now);
  assert.equal(summary.confirmed7,0);
  assert.equal(summary.confirmed30,14.99);
  assert.equal(summary.uncertainCount,1);
  assert.equal(summary.uncertainAmount,1999);
});

test('requires a passing Canva DKIM result coupled to the authenticated Canva domain',()=>{
  const confirmation=(auth?:string,from='no-reply@canva.com')=>canvaCancellationEvidence(message('Your subscription has been canceled','Cancellation confirmed.',from,auth));
  assert.ok(confirmation('mx.google.com; dkim=pass header.d=canva.com'));
  assert.ok(confirmation('mx.google.com; dkim=pass header.d=mail.canva.com'));
  assert.equal(confirmation('mx.google.com; dkim=pass header.d=evil.com; dkim=fail header.d=canva.com'),null);
  assert.equal(confirmation('mx.google.com; dkim=fail header.d=canva.com; dkim=pass header.d=evil.com'),null);
  assert.equal(confirmation(undefined,'Canva <no-reply@canva.com>'),null);
});

test('does not treat instructional Canva mail as cancellation evidence',()=>{
  const result=canvaCancellationEvidence(message(
    'How to cancel your plan?',
    'Your subscription has been canceled.',
    'no-reply@canva.com',
    'mx.google.com; dkim=pass header.d=canva.com'
  ));
  assert.equal(result,null);
});

test('A. DATE-ONLY GMAIL SOURCE: stored provider date remains 2026-09-10 and preserves calendar semantics', () => {
  const result = classifySignal(message(
    'Your free trial has started',
    'Your trial ends September 10, 2026. You will be charged $14.99/month after your trial.',
    'no-reply@canva.com'
  ));
  assert.ok(result);
  assert.equal(result.providerTrialEndDate, '2026-09-10', 'providerTrialEndDate must exactly record calendar date');
  assert.equal(result.hasExplicitTime, false, 'hasExplicitTime must be false for date-only provider text');
  assert.equal(result.trialEnd, '2026-09-10T00:00:00.000Z', 'trialEnd cutoff must deterministically represent start of calendar date in UTC');
});

test('B. TIMEZONE REGRESSION: displayed provider date remains September 10 in NY, UTC, and LA', () => {
  const result = classifySignal(message(
    'Your free trial has started',
    'Your trial ends September 10, 2026. You will be charged $14.99/month after your trial.',
    'no-reply@canva.com'
  ));
  assert.ok(result);
  assert.equal(result.providerTrialEndDate, '2026-09-10');

  const targetDate = result.providerTrialEndDate!;
  const timezones = ['America/New_York', 'UTC', 'America/Los_Angeles'];

  for (const tz of timezones) {
    process.env.TZ = tz;
    const formattedShort = formatCalendarDate(targetDate, { month: 'short', day: 'numeric' });
    const formattedFull = formatCalendarDate(targetDate, { month: 'long', day: 'numeric', year: 'numeric' });
    const formattedMonthDay = formatCalendarDate(targetDate, { month: 'long', day: 'numeric' });

    assert.equal(formattedShort, 'Sep 10', `Short date in ${tz} must be Sep 10, never Sep 9`);
    assert.equal(formattedFull, 'September 10, 2026', `Full date in ${tz} must be September 10, 2026`);
    assert.equal(formattedMonthDay, 'September 10', `Month-day in ${tz} must be September 10`);
  }
});

test('C. DERIVED SAFE CANCEL DEADLINE: deterministic and conservative cutoff timing', () => {
  const result = classifySignal(message(
    'Your free trial has started',
    'Your trial ends September 10, 2026. You will be charged $14.99/month after your trial.',
    'no-reply@canva.com'
  ));
  assert.ok(result);
  assert.equal(result.trialEnd, '2026-09-10T00:00:00.000Z');
  assert.equal(result.safeDeadline, '2026-09-08T00:00:00.000Z');
  assert.equal(result.plannedExecution, '2026-09-07T23:00:00.000Z');

  const tPlanned = new Date(result.plannedExecution).getTime();
  const tDeadline = new Date(result.safeDeadline).getTime();
  const tEnd = new Date(result.trialEnd).getTime();
  assert.ok(tPlanned < tDeadline, 'Planned action must execute before safe cancel deadline');
  assert.ok(tDeadline < tEnd, 'Safe cancel deadline must precede provider renewal cutoff');
  assert.equal(tDeadline - tPlanned, 3600000, 'Planned execution is 1 hour before deadline');
  assert.equal(tEnd - tDeadline, 48 * 3600000, 'Deadline is 48 hours before renewal cutoff');
});

test('D. EXPLICIT TIMESTAMP CASE: preserves explicit provider timestamp and timezone separately', () => {
  const msgExplicit = message(
    'Your free trial has started',
    'Your trial ends September 10, 2026 at 3:00 PM UTC. You will be charged $14.99/month after your trial.',
    'no-reply@canva.com'
  );
  const resExplicit = classifySignal(msgExplicit);
  assert.ok(resExplicit);
  assert.equal(resExplicit.hasExplicitTime, true);
  assert.equal(resExplicit.providerTrialEndDate, '2026-09-10');
  assert.equal(resExplicit.trialEnd, '2026-09-10T15:00:00.000Z');
  assert.equal(resExplicit.safeDeadline, '2026-09-08T15:00:00.000Z');
  assert.equal(resExplicit.plannedExecution, '2026-09-08T14:00:00.000Z');

  const msgIso = message(
    'Your free trial has started',
    'Your trial ends 2026-09-10T15:00:00Z. You will be charged $14.99/month after your trial.',
    'no-reply@canva.com'
  );
  const resIso = classifySignal(msgIso);
  assert.ok(resIso);
  assert.equal(resIso.hasExplicitTime, true);
  assert.equal(resIso.providerTrialEndDate, '2026-09-10');
  assert.equal(resIso.trialEnd, '2026-09-10T15:00:00.000Z');
  assert.equal(resIso.safeDeadline, '2026-09-08T15:00:00.000Z');
  assert.equal(resIso.plannedExecution, '2026-09-08T14:00:00.000Z');
});

test('E. MONTHLY PRICE: $14.99/month is not misrepresented as a provider annual plan', () => {
  const result = classifySignal(message(
    'Your free trial has started',
    'Your trial ends September 10, 2026. You will be charged $14.99/month after your trial.',
    'no-reply@canva.com'
  ));
  assert.ok(result);
  assert.equal(result.price, 14.99);
  assert.equal(result.currency, 'USD');
  assert.ok(!/annual/i.test(result.plan), 'plan name must not invent annual billing');
});

test('does not advance Gmail history while candidate retrieval needs retry',()=>{
  assert.equal(nextHistoryCheckpoint('new-history','old-history',1),'old-history');
  assert.equal(nextHistoryCheckpoint('new-history',undefined,1),'');
  assert.equal(nextHistoryCheckpoint('new-history','old-history',0),'new-history');
});

test('F1. PROMOTIONAL: Honey price drops droplist alert', () => {
  const res = classifySignal(message(
    'We found price drops for an item you Droplisted',
    'An item you saved on your Droplist dropped in price by $15. Check out the deal before it expires.',
    'droplist@joinhoney.com'
  ));
  assert.ok(res);
  assert.equal(res.kind, 'PROMOTIONAL');
  assert.equal(res.price, 0);
  assert.equal(res.providerTrialEndDate, undefined);
  assert.equal(res.trialEnd, undefined);
  assert.equal(res.safeDeadline, undefined);
  assert.equal(res.plannedExecution, undefined);
});

test('F2. PROMOTIONAL: Xfinity Samsung S25+ ON US hardware deal', () => {
  const res = classifySignal(message(
    'Available now! Samsung S25+ ON US',
    'Get the new Samsung S25+ on us when you add a line. Limited time offer.',
    'online.communications@alerts.comcast.net'
  ));
  assert.ok(res);
  assert.equal(res.kind, 'PROMOTIONAL');
  assert.equal(res.price, 0);
  assert.equal(res.providerTrialEndDate, undefined);
  assert.equal(res.trialEnd, undefined);
  assert.equal(res.safeDeadline, undefined);
  assert.equal(res.plannedExecution, undefined);
});

test('F3. PROMOTIONAL: Xfinity FREE 5G phone + up to $500 switch offer', () => {
  const res = classifySignal(message(
    'Get a FREE 5G phone + up to $500 when you switch',
    'Switch to Xfinity Mobile today! Get a free 5G phone and a $500 Visa prepaid card. Offer ends October 15, 2026.',
    'online.communications@alerts.comcast.net'
  ));
  assert.ok(res);
  assert.equal(res.kind, 'PROMOTIONAL');
  assert.equal(res.price, 0);
  assert.equal(res.providerTrialEndDate, undefined);
  assert.equal(res.trialEnd, undefined);
  assert.equal(res.safeDeadline, undefined);
  assert.equal(res.plannedExecution, undefined);
});

test('F4. PROMOTIONAL: Xfinity up to $1,000 off select 5G phones', () => {
  const res = classifySignal(message(
    'Just for you: Up to $1,000 off select 5G phones',
    'Upgrade your phone! Trade in your old device and get up to $1,000 off select 5G phones.',
    'online.communications@alerts.comcast.net'
  ));
  assert.ok(res);
  assert.equal(res.kind, 'PROMOTIONAL');
  assert.equal(res.price, 0);
  assert.equal(res.providerTrialEndDate, undefined);
  assert.equal(res.trialEnd, undefined);
  assert.equal(res.safeDeadline, undefined);
  assert.equal(res.plannedExecution, undefined);
});

test('F5. PROMOTIONAL: Start your free trial CTA invitation', () => {
  const res = classifySignal(message(
    'Start your free trial',
    'Try Pro free for 30 days. Explore all our advanced features today. Claim your trial!',
    'marketing@creativetools.io'
  ));
  assert.ok(res);
  assert.equal(res.kind, 'PROMOTIONAL');
  assert.equal(res.price, 0);
  assert.equal(res.providerTrialEndDate, undefined);
  assert.equal(res.trialEnd, undefined);
  assert.equal(res.safeDeadline, undefined);
  assert.equal(res.plannedExecution, undefined);
});

test('F6. PROMOTIONAL: Get 3 months free marketing offer', () => {
  const res = classifySignal(message(
    'Get 3 months free',
    'Special summer invitation: get 3 months free on annual plans when you sign up today.',
    'offers@musicservice.com'
  ));
  assert.ok(res);
  assert.equal(res.kind, 'PROMOTIONAL');
  assert.equal(res.price, 0);
  assert.equal(res.providerTrialEndDate, undefined);
  assert.equal(res.trialEnd, undefined);
  assert.equal(res.safeDeadline, undefined);
  assert.equal(res.plannedExecution, undefined);
});

test('F7. PROMOTIONAL: Generic upgrade offer', () => {
  const res = classifySignal(message(
    'Exclusive upgrade offer for your account',
    'Upgrade offer: switch to our premium device tier and receive $200 in billing credit.',
    'updates@devicecarrier.net'
  ));
  assert.ok(res);
  assert.equal(res.kind, 'PROMOTIONAL');
  assert.equal(res.price, 0);
  assert.equal(res.providerTrialEndDate, undefined);
  assert.equal(res.trialEnd, undefined);
  assert.equal(res.safeDeadline, undefined);
  assert.equal(res.plannedExecution, undefined);
});

test('F8. PROMOTIONAL: Retention offer', () => {
  const res = classifySignal(message(
    'Special retention offer just for you',
    'Retention offer: stay with our service and get a $100 gift card on your next invoice.',
    'retention@broadbandservice.com'
  ));
  assert.ok(res);
  assert.equal(res.kind, 'PROMOTIONAL');
  assert.equal(res.price, 0);
  assert.equal(res.providerTrialEndDate, undefined);
  assert.equal(res.trialEnd, undefined);
  assert.equal(res.safeDeadline, undefined);
  assert.equal(res.plannedExecution, undefined);
});

test('F9. PROMOTIONAL: Bundle offer', () => {
  const res = classifySignal(message(
    'Exclusive bundle offer available now',
    'Bundle offer: combine your home internet and mobile plans to save up to $400 a year.',
    'sales@telecomgroup.com'
  ));
  assert.ok(res);
  assert.equal(res.kind, 'PROMOTIONAL');
  assert.equal(res.price, 0);
  assert.equal(res.providerTrialEndDate, undefined);
  assert.equal(res.trialEnd, undefined);
  assert.equal(res.safeDeadline, undefined);
  assert.equal(res.plannedExecution, undefined);
});

test('F10. PROMOTIONAL: Hardware promotion', () => {
  const res = classifySignal(message(
    'Special hardware promotion: 50% off select tablets',
    'Hardware promotion: buy one tablet and get one free with any qualifying 2-year service agreement.',
    'promotions@techhardware.com'
  ));
  assert.ok(res);
  assert.equal(res.kind, 'PROMOTIONAL');
  assert.equal(res.price, 0);
  assert.equal(res.providerTrialEndDate, undefined);
  assert.equal(res.trialEnd, undefined);
  assert.equal(res.safeDeadline, undefined);
  assert.equal(res.plannedExecution, undefined);
});

test('F11. PROMOTIONAL: Generic marketing message', () => {
  const res = classifySignal(message(
    'Summer deals are here: Save big on gear',
    'Check out our summer clearance sale with huge discounts on all accessories. Use promo code SUMMER20.',
    'deals@retailmerchant.com'
  ));
  assert.ok(res);
  assert.equal(res.kind, 'PROMOTIONAL');
  assert.equal(res.price, 0);
  assert.equal(res.providerTrialEndDate, undefined);
  assert.equal(res.trialEnd, undefined);
  assert.equal(res.safeDeadline, undefined);
  assert.equal(res.plannedExecution, undefined);
});

test('G. CONTEXTUAL RECURRING PRICE EXTRACTION: thousands separator bug fixed, marketing credits ignored', () => {
  // $14.99/month
  assert.equal(extractRecurringPrice('You will be charged $14.99/month after trial'), 14.99);
  assert.equal(extractRecurringPrice('Renews at $29.99 per month'), 29.99);
  assert.equal(extractRecurringPrice('Upcoming charge of $99 / year'), 99);
  assert.equal(extractRecurringPrice('$49.99 monthly subscription fee'), 49.99);

  // $1,000 credit or phone discount must NOT be parsed as $1.00
  assert.equal(extractRecurringPrice('Get up to $1,000 credit towards your trade-in phone'), 0);
  assert.equal(extractRecurringPrice('Save up to $800 on your next device'), 0);
  assert.equal(extractRecurringPrice('Receive a $500 Visa prepaid card when you switch'), 0);
  assert.equal(extractRecurringPrice('$50 off your purchase of $150 or more'), 0);
});

test('H. CONTEXTUAL TRIAL/RENEWAL DATE EXTRACTION: marketing dates ignored, renewal dates captured', () => {
  const received = new Date('2026-09-01T12:00:00Z');

  // Valid renewal context
  const validSignal = extractDateSignal(
    'Your free trial has started. Your trial ends September 10, 2026. You will be charged $14.99/month after your trial.',
    received,
    true
  );
  assert.equal(validSignal.providerTrialEndDate, '2026-09-10');
  assert.equal(validSignal.trialEnd, '2026-09-10T00:00:00.000Z');
  assert.equal(validSignal.safeDeadline, '2026-09-08T00:00:00.000Z');

  // Marketing date without trial/renewal context must NOT be extracted
  const marketingSignal = extractDateSignal(
    'Special summer offer valid through September 10, 2026. Save $800 on a new phone when you switch.',
    received,
    true
  );
  assert.equal(marketingSignal.providerTrialEndDate, undefined);
  assert.equal(marketingSignal.trialEnd, undefined);
  assert.equal(marketingSignal.safeDeadline, undefined);
});

test('I. NO SAFE CANCEL DEADLINES FOR POSSIBLE OR PROMOTIONAL SIGNALS', () => {
  // Possible finding (unconfirmed subscription update)
  const possible = classifySignal(message(
    'Subscription update',
    'Your account membership status has been updated. Review your details online.',
    'billing@dropbox.com'
  ));
  assert.ok(possible);
  assert.equal(possible.kind, 'POSSIBLE');
  assert.equal(possible.safeDeadline, undefined, 'POSSIBLE signal must never have a derived safe cancel deadline');
  assert.equal(possible.plannedExecution, undefined, 'POSSIBLE signal must never have a derived planned execution');

  // Promotional finding
  const promo = classifySignal(message(
    'We found price drops for an item you Droplisted',
    'Item dropped by $15 on September 10, 2026.',
    'droplist@joinhoney.com'
  ));
  assert.ok(promo);
  assert.equal(promo.kind, 'PROMOTIONAL');
  assert.equal(promo.safeDeadline, undefined);
  assert.equal(promo.plannedExecution, undefined);
});

test('J. GOOGLE OAUTH PROMPT INCLUDES select_account FOR RECONNECT FLOW', () => {
  const backendIndex = fs.readFileSync('C:/Users/lexro/trialvisor/backend/index.ts', 'utf8');
  assert.ok(
    backendIndex.includes("prompt:'select_account consent'"),
    'Google OAuth start must include select_account in prompt parameter'
  );
});

test('K. V4 MIGRATION REPROCESSING SAFETY: promotional items dismissed, user-authorized records preserved', () => {
  const backendIndex = fs.readFileSync('C:/Users/lexro/trialvisor/backend/index.ts', 'utf8');
  assert.ok(
    backendIndex.includes('GMAIL_PROCESSOR_VERSION=5'),
    'GMAIL_PROCESSOR_VERSION must be incremented to 5'
  );
  assert.ok(
    backendIndex.includes("if(!t.id||t.state!=='REVIEW_REQUIRED')continue;"),
    'Migration must strictly preserve user-authorized records and only dismiss uncommitted REVIEW_REQUIRED items'
  );
});

test('L. MIXED-CONTENT BILLING EVIDENCE: legitimate renewal notice with marketing copy remains ACTIVE', () => {
  const res = classifySignal(message(
    'Your subscription renews September 10 at $14.99/month. Upgrade today and save 20%.',
    'Thank you for being a customer. Your subscription renews on September 10, 2026. You will be charged $14.99/month. Upgrade today to our premium plan and save 20% with this special offer.',
    'billing@cloudservices.com'
  ));
  assert.ok(res, 'Mixed-content billing email must be detected');
  assert.equal(res.kind, 'ACTIVE', 'Legitimate renewal must be classified as ACTIVE, not PROMOTIONAL');
  assert.equal(res.price, 14.99, 'Must extract exact monthly recurring price');
  assert.equal(res.providerTrialEndDate, '2026-09-10');
  assert.equal(res.trialEnd, '2026-09-10T00:00:00.000Z');
  assert.equal(res.safeDeadline, '2026-09-08T00:00:00.000Z');
  assert.equal(res.plannedExecution, '2026-09-07T23:00:00.000Z');
  assert.equal(res.confidenceBand, 'HIGH');
  assert.equal(res.state, 'REVIEW_REQUIRED');
});
