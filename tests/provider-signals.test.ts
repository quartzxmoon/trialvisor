import assert from 'node:assert/strict';
import test from 'node:test';
import { canvaCancellationEvidence, classifySignal, extractProvider, formatCalendarDate, nextHistoryCheckpoint, type GmailMessage } from '../backend/provider-signals.ts';

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
});

test('retains distinct medium and low confidence bands',()=>{
  const medium=classifySignal(message('Your free trial has started','Welcome.','billing@dropbox.com'));
  const low=classifySignal(message('Subscription update','Welcome.','billing@dropbox.com'));
  assert.equal(medium?.confidenceBand,'MEDIUM');
  assert.equal(low?.confidenceBand,'LOW');
  assert.equal(medium?.state,'REVIEW_REQUIRED');
  assert.equal(low?.state,'REVIEW_REQUIRED');
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
