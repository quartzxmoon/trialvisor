import assert from 'node:assert/strict';
import test from 'node:test';
import { canvaCancellationEvidence, classifyMessage, classifySignal, exposureSummary, extractProvider, formatCalendarDate, mergeSourceReferences, nextHistoryCheckpoint, sameSubscriptionEntity, type GmailMessage } from '../backend/provider-signals.ts';

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
