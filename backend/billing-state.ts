export const STRIPE_PRICE_PRO_MONTHLY='price_1UBuOfGTXvZ0TX3Afx0TbBsm';
export const STRIPE_PRICE_PRO_ANNUAL='price_1UBuSLGTXvZ0TX3AtAl720ek';
export const ACTIVE_BILLING_STATUSES=new Set(['active','trialing']);
export const APPROVED_PRICE_IDS=new Set([STRIPE_PRICE_PRO_MONTHLY,STRIPE_PRICE_PRO_ANNUAL]);
export const CHECKOUT_BLOCKED_STATUSES=new Set(['active','trialing','pending','past_due','unpaid','paused','incomplete','unrecognized_price']);
export const CHECKOUT_AVAILABLE_STATUSES=new Set(['inactive','canceled','incomplete_expired','checkout_abandoned']);
export const BILLING_ATTENTION_STATUSES=new Set(['pending','past_due','unpaid','paused','incomplete','unrecognized_price']);

export type BillingRecord={
  id?:string;
  userId:string;
  customerId?:string;
  subscriptionId?:string;
  status:string;
  plan:'FREE'|'PRO';
  cadence?:'monthly'|'annual';
  priceId?:string;
  currentPeriodEnd?:string;
  cancelAtPeriodEnd?:boolean;
  lastCheckoutAt?:string;
  lastCheckoutSessionId?:string;
  lastStripeEventId?:string;
  lastStripeEventCreated?:number;
  lastCheckoutEventCreated?:number;
  lastSubscriptionEventCreated?:number;
  lastInvoiceEventCreated?:number;
  lastReconciledAt?:string;
  updatedAt:string;
};

export type StripeSubscriptionLike={
  id:string;
  status:string;
  customer:string|{id?:string}|null;
  created?:number;
  cancel_at_period_end?:boolean;
  metadata?:Record<string,string>;
  items:{data:Array<{price?:{id?:string};current_period_end?:number}>};
};

export type BillingProjection={
  customerId?:string;
  subscriptionId:string;
  status:string;
  plan:'FREE'|'PRO';
  cadence?:'monthly'|'annual';
  priceId?:string;
  currentPeriodEnd?:string;
  cancelAtPeriodEnd:boolean;
};

const safeId=(value:unknown,prefix:string)=>{
  if(typeof value==='string'&&value.startsWith(prefix))return value;
  if(value&&typeof value==='object'&&'id' in value){const id=(value as {id?:unknown}).id;return typeof id==='string'&&id.startsWith(prefix)?id:undefined}
  return undefined;
};
const periodEnd=(seconds:unknown)=>typeof seconds==='number'?new Date(seconds*1000).toISOString():undefined;

export const priceForCadence=(cadence:unknown)=>cadence==='monthly'?STRIPE_PRICE_PRO_MONTHLY:cadence==='annual'?STRIPE_PRICE_PRO_ANNUAL:null;
export const stripeEventMarkerKey=(eventId:string)=>'stripe-event:'+eventId;
export const isProBilling=(record?:Partial<BillingRecord>)=>!!record&&ACTIVE_BILLING_STATUSES.has(record.status||'')&&!!record.priceId&&APPROVED_PRICE_IDS.has(record.priceId);

export const projectSubscription=(subscription:StripeSubscriptionLike,userId?:string):BillingProjection|null=>{
  if(userId&&(subscription.metadata?.trialvisor_user_id!==userId||subscription.metadata?.trialvisor_plan!=='PRO'))return null;
  const item=subscription.items.data[0],priceId=item?.price?.id,customerId=safeId(subscription.customer,'cus_');
  if(!customerId)return null;
  const recognized=!!priceId&&APPROVED_PRICE_IDS.has(priceId);
  const active=recognized&&ACTIVE_BILLING_STATUSES.has(subscription.status);
  return{
    customerId,
    subscriptionId:subscription.id,
    status:recognized?subscription.status:'unrecognized_price',
    plan:active?'PRO':'FREE',
    cadence:priceId===STRIPE_PRICE_PRO_ANNUAL?'annual':priceId===STRIPE_PRICE_PRO_MONTHLY?'monthly':undefined,
    priceId,
    currentPeriodEnd:periodEnd(item?.current_period_end),
    cancelAtPeriodEnd:!!subscription.cancel_at_period_end
  };
};

const subscriptionRank=(subscription:StripeSubscriptionLike)=>{
  if(ACTIVE_BILLING_STATUSES.has(subscription.status))return 4;
  if(BILLING_ATTENTION_STATUSES.has(subscription.status))return 3;
  if(subscription.status==='canceled'||subscription.status==='incomplete_expired')return 1;
  return 2;
};

export const selectCanonicalSubscription=(subscriptions:StripeSubscriptionLike[],userId:string)=>subscriptions
  .filter(subscription=>projectSubscription(subscription,userId)!==null)
  .sort((a,b)=>subscriptionRank(b)-subscriptionRank(a)||(b.created||0)-(a.created||0))[0];

export const checkoutCompletionPatch=(prior:BillingRecord,session:{customerId:string;subscriptionId?:string;cadence:'monthly'|'annual'})=>{
  const alreadyActive=isProBilling(prior);
  return{
    customerId:session.customerId,
    subscriptionId:session.subscriptionId||prior.subscriptionId,
    status:alreadyActive?prior.status:'pending',
    plan:alreadyActive?'PRO' as const:'FREE' as const,
    cadence:alreadyActive?prior.cadence:session.cadence,
    priceId:alreadyActive?prior.priceId:undefined,
    currentPeriodEnd:alreadyActive?prior.currentPeriodEnd:undefined,
    cancelAtPeriodEnd:alreadyActive?prior.cancelAtPeriodEnd:false
  };
};

export const billingPresentation=(record:BillingRecord|undefined,configured:boolean,reconciliation:'synced'|'stale'|'error')=>{
  const plan=isProBilling(record)?'PRO' as const:'FREE' as const,status=record?.status||'inactive';
  const needsAttention=BILLING_ATTENTION_STATUSES.has(status)||reconciliation==='error';
  const canCheckout=configured&&reconciliation!=='error'&&(!record||CHECKOUT_AVAILABLE_STATUSES.has(status)||status==='checkout_pending');
  const message=reconciliation==='error'
    ?'Trialvisor could not verify current billing state with Stripe. Purchase controls are paused; retry before changing your plan.'
    :BILLING_ATTENTION_STATUSES.has(status)
      ?'Your Stripe billing state needs attention. Manage billing or retry status verification before starting another Checkout.'
      :status==='checkout_pending'
        ?'A Stripe Checkout is already in progress. Continue the existing secure Checkout.'
        :null;
  return{plan,status,needsAttention,canCheckout,checkoutPending:status==='checkout_pending',reconciliation,message};
};
