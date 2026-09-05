import assert from 'node:assert/strict';
import test from 'node:test';
import { canvaCancellationEvidence, classifySignal, extractProvider, type GmailMessage } from '../backend/provider-signals.ts';

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
  assert.equal(result.trialEnd,'2026-09-10T04:00:00.000Z');
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
