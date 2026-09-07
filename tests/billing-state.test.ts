import assert from 'node:assert/strict';
import test from 'node:test';
import { billingPresentation, checkoutCompletionPatch, priceForCadence, projectSubscription, selectCanonicalSubscription, stripeEventMarkerKey, STRIPE_PRICE_PRO_ANNUAL, STRIPE_PRICE_PRO_MONTHLY, type BillingRecord, type StripeSubscriptionLike } from '../backend/billing-state.ts';

const userId='f36f34c5-87ca-4e6d-abb7-0e2611cbf26c';
const baseRecord=(patch:Partial<BillingRecord>={}):BillingRecord=>({userId,status:'inactive',plan:'FREE',updatedAt:'2026-09-07T00:00:00.000Z',...patch});
const subscription=(patch:Partial<StripeSubscriptionLike>={}):StripeSubscriptionLike=>({
  id:'sub_annual',status:'active',customer:'cus_annual',created:200,cancel_at_period_end:false,
  metadata:{trialvisor_user_id:userId,trialvisor_plan:'PRO',trialvisor_cadence:'annual'},
  items:{data:[{price:{id:STRIPE_PRICE_PRO_ANNUAL},current_period_end:1820070477}]},...patch
});

test('maps monthly and yearly CTA choices only to the approved Trialvisor Price IDs',()=>{
  assert.equal(priceForCadence('monthly'),STRIPE_PRICE_PRO_MONTHLY);
  assert.equal(priceForCadence('annual'),STRIPE_PRICE_PRO_ANNUAL);
  assert.equal(priceForCadence('enterprise'),null);
});

test('projects active monthly and yearly Stripe subscriptions into server-owned Pro state',()=>{
  const annual=projectSubscription(subscription(),userId)!;
  const monthly=projectSubscription(subscription({id:'sub_monthly',customer:'cus_monthly',metadata:{trialvisor_user_id:userId,trialvisor_plan:'PRO',trialvisor_cadence:'monthly'},items:{data:[{price:{id:STRIPE_PRICE_PRO_MONTHLY},current_period_end:1791126477}]}}),userId)!;
  assert.deepEqual([annual.plan,annual.cadence,annual.status],['PRO','annual','active']);
  assert.deepEqual([monthly.plan,monthly.cadence,monthly.status],['PRO','monthly','active']);
});

test('rejects cross-tenant metadata and never grants Pro for an unapproved Price',()=>{
  assert.equal(projectSubscription(subscription(),'different-tenant'),null);
  const invalid=projectSubscription(subscription({items:{data:[{price:{id:'price_unapproved'}}]}}),userId)!;
  assert.equal(invalid.plan,'FREE');
  assert.equal(invalid.status,'unrecognized_price');
});

test('canonical reconciliation prefers the active annual subscription over an older canceled monthly subscription',()=>{
  const canceled=subscription({id:'sub_old_monthly',status:'canceled',customer:'cus_old',created:100,metadata:{trialvisor_user_id:userId,trialvisor_plan:'PRO',trialvisor_cadence:'monthly'},items:{data:[{price:{id:STRIPE_PRICE_PRO_MONTHLY}}]}});
  assert.equal(selectCanonicalSubscription([canceled,subscription()],userId)?.id,'sub_annual');
});

test('webhook order subscription then checkout cannot demote an active annual Pro record',()=>{
  const start=baseRecord({status:'checkout_pending',cadence:'annual'});
  const projected=projectSubscription(subscription(),userId)!;
  const active=baseRecord({...start,...projected});
  const afterCheckout=baseRecord({...active,...checkoutCompletionPatch(active,{customerId:'cus_annual',subscriptionId:'sub_annual',cadence:'annual'})});
  assert.equal(afterCheckout.plan,'PRO');
  assert.equal(afterCheckout.status,'active');
  assert.equal(afterCheckout.cadence,'annual');
});

test('webhook order checkout then subscription activates Pro only after subscription state',()=>{
  const start=baseRecord({status:'checkout_pending',cadence:'annual'});
  const pending=baseRecord({...start,...checkoutCompletionPatch(start,{customerId:'cus_annual',subscriptionId:'sub_annual',cadence:'annual'})});
  assert.equal(pending.plan,'FREE');
  assert.equal(pending.status,'pending');
  const active=baseRecord({...pending,...projectSubscription(subscription(),userId)!});
  assert.equal(active.plan,'PRO');
  assert.equal(active.cadence,'annual');
});

test('billing presentation retains paid access through cancel-at-period-end and safely frees expired subscriptions',()=>{
  const active=baseRecord({status:'active',plan:'PRO',priceId:STRIPE_PRICE_PRO_ANNUAL,cadence:'annual',cancelAtPeriodEnd:true,customerId:'cus_annual'});
  const paid=billingPresentation(active,true,'synced');
  assert.equal(paid.plan,'PRO');
  assert.equal(paid.canCheckout,false);
  const expired=billingPresentation(baseRecord({status:'canceled',plan:'FREE',priceId:STRIPE_PRICE_PRO_ANNUAL,cadence:'annual',customerId:'cus_annual'}),true,'synced');
  assert.equal(expired.plan,'FREE');
  assert.equal(expired.canCheckout,true,'expired customer can resubscribe while retaining the customer binding');
});

test('pending and failed billing states are visible instead of silently rendering purchasable Free',()=>{
  const pending=billingPresentation(baseRecord({status:'pending'}),true,'synced');
  assert.equal(pending.canCheckout,false);
  assert.equal(pending.needsAttention,true);
  assert.ok(pending.message);
  const unavailable=billingPresentation(undefined,true,'error');
  assert.equal(unavailable.canCheckout,false);
  assert.equal(unavailable.needsAttention,true);
});

test('an open Checkout is represented as resumable and duplicate event IDs use one marker',()=>{
  const checkout=billingPresentation(baseRecord({status:'checkout_pending',cadence:'annual'}),true,'synced');
  assert.equal(checkout.checkoutPending,true);
  assert.equal(checkout.canCheckout,true);
  assert.equal(stripeEventMarkerKey('evt_replay'),stripeEventMarkerKey('evt_replay'));
});
