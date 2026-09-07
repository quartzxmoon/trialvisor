import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const backend=readFileSync(new URL('../backend/index.ts',import.meta.url),'utf8');
const billing=readFileSync(new URL('../backend/billing.ts',import.meta.url),'utf8');
const client=readFileSync(new URL('../src/App.tsx',import.meta.url),'utf8');

test('billing checkout and portal require authentication plus exact Trialvisor session enforcement',()=>{
  assert.match(backend,/'POST \/api\/billing\/checkout':\[requireAuth\(\),enforceSession\(\{touchActivity:true\}\)/);
  assert.match(backend,/'POST \/api\/billing\/portal':\[requireAuth\(\),enforceSession\(\{touchActivity:true\}\)/);
  assert.match(client,/headers:\{'X-Session-Id':sid\}/);
});

test('monthly and annual controls call the server checkout route and redirect only to its returned URL',()=>{
  assert.match(client,/openCheckout\('monthly'\)/);
  assert.match(client,/openCheckout\('annual'\)/);
  assert.match(client,/post\('\/api\/billing\/checkout',\{cadence\},false\)/);
  assert.match(client,/window\.location\.assign\(r\.url\)/);
});

test('Checkout creates approved subscription sessions, returns a URL, and is idempotent against double clicks',()=>{
  assert.match(billing,/mode:'subscription'/);
  assert.match(billing,/line_items:\[\{price:priceId,quantity:1\}\]/);
  assert.match(billing,/idempotencyKey:`trialvisor-checkout-/);
  assert.match(billing,/return json\(\{url:session\.url\}\)/);
  assert.match(client,/billingRedirectRef\.current/);
});

test('signed webhook verification and replay marker enforcement remain intact',()=>{
  assert.match(billing,/stripe\.webhooks\.constructEvent\(body,signature,endpointSecret\)/);
  assert.match(billing,/if\(seen\.length\)return json\(\{received:true,duplicate:true\}\)/);
  assert.match(billing,/stripeEventMarkerKey\(stripeEvent\.id\)/);
});

test('Plan & Billing renders server state, visible failures, actual cadence, and reconciliation warnings',()=>{
  assert.match(client,/snap\.billing\.plan==='PRO'/);
  assert.match(client,/snap\.billing\.cadence==='annual'/);
  assert.match(client,/role='alert'>\{error\}/);
  assert.match(client,/snap\.billing\.message/);
  assert.match(client,/snap\.billing\.canCheckout/);
});
