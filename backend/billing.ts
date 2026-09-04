import Stripe from 'stripe';
import { db, error, json, notifications, secrets } from '@appdeploy/sdk';

const APP_URL='https://trialvisor-m8vrsu.v2.appdeploy.ai/';
const STRIPE_PRICE_PRO_MONTHLY='price_1UBuOfGTXvZ0TX3Afx0TbBsm';
const STRIPE_PRICE_PRO_ANNUAL='price_1UBuSLGTXvZ0TX3AtAl720ek';
const REQUIRED_SECRETS=['STRIPE_RESTRICTED_KEY','STRIPE_WEBHOOK_SECRET'];
const ACTIVE_STATUSES=new Set(['active','trialing']);
const APPROVED_PRICE_IDS=new Set([STRIPE_PRICE_PRO_MONTHLY,STRIPE_PRICE_PRO_ANNUAL]);
const CHECKOUT_BLOCKED_STATUSES=new Set(['active','trialing','pending','past_due','unpaid','paused','incomplete','unrecognized_price']);

type BillingRecord={
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
  updatedAt:string;
};
type CustomerBinding={id?:string;customerId:string;userId:string;boundAt:string};

const billingTable=(userId:string)=>'billing:'+userId;
const customerBindingTable=(customerId:string)=>'stripe-customer-binding:'+customerId;
const billingNotice=async(userId:string,title:string,message:string,severity:'info'|'warning'|'critical'|'success')=>{await db.add('notifications:'+userId,[{userId,kind:'billing',title,message,severity,at:new Date().toISOString(),readAt:null,actionView:'billing'}])};
const stripeClient=async()=>new Stripe(await secrets.readSecret('STRIPE_RESTRICTED_KEY'),{
  apiVersion:'2026-08-26.dahlia',
  maxNetworkRetries:2,
  timeout:10000,
  appInfo:{name:'Trialvisor',version:'1.0.0',url:APP_URL}
});
const configuredNames=async()=>new Set(await secrets.listSecretNames());
export const billingConfigured=async()=>{const names=await configuredNames();return REQUIRED_SECRETS.every(name=>names.has(name))};
const currentBilling=async(userId:string)=>(await db.list<BillingRecord>(billingTable(userId),{limit:5})).items.sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt))[0];
const saveBilling=async(userId:string,patch:Partial<BillingRecord>)=>{
  const current=await currentBilling(userId),next:BillingRecord={
    userId,
    customerId:patch.customerId??current?.customerId,
    subscriptionId:patch.subscriptionId??current?.subscriptionId,
    status:patch.status??current?.status??'inactive',
    plan:patch.plan??current?.plan??'FREE',
    cadence:patch.cadence??current?.cadence,
    priceId:patch.priceId??current?.priceId,
    currentPeriodEnd:patch.currentPeriodEnd??current?.currentPeriodEnd,
    cancelAtPeriodEnd:patch.cancelAtPeriodEnd??current?.cancelAtPeriodEnd??false,
    lastCheckoutAt:patch.lastCheckoutAt??current?.lastCheckoutAt,
    lastCheckoutSessionId:patch.lastCheckoutSessionId??current?.lastCheckoutSessionId,
    lastStripeEventId:patch.lastStripeEventId??current?.lastStripeEventId,
    lastStripeEventCreated:patch.lastStripeEventCreated??current?.lastStripeEventCreated,
    lastCheckoutEventCreated:patch.lastCheckoutEventCreated??current?.lastCheckoutEventCreated,
    lastSubscriptionEventCreated:patch.lastSubscriptionEventCreated??current?.lastSubscriptionEventCreated,
    lastInvoiceEventCreated:patch.lastInvoiceEventCreated??current?.lastInvoiceEventCreated,
    updatedAt:new Date().toISOString()
  };
  if(current){const [ok]=await db.update(billingTable(userId),[{id:current.id,record:next}]);if(!ok)throw new Error('billing_update_failed')}
  else{const [id]=await db.add(billingTable(userId),[next]);if(!id)throw new Error('billing_create_failed')}
  return next;
};
const safeId=(value:unknown,prefix:string)=>typeof value==='string'&&value.startsWith(prefix)?value:undefined;
const periodEnd=(seconds:unknown)=>typeof seconds==='number'?new Date(seconds*1000).toISOString():undefined;
const randomLetters=(length:number)=>Array.from(crypto.getRandomValues(new Uint8Array(length)),byte=>String.fromCharCode(97+(byte%26))).join('');
const rawBody=(event:any)=>{
  const value=typeof event?.body==='string'?event.body:'';
  if(!event?.isBase64Encoded)return value;
  const binary=atob(value),bytes=Uint8Array.from(binary,char=>char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
};
const header=(event:any,name:string)=>{
  const headers=(event?.headers||{}) as Record<string,string|undefined>,target=name.toLowerCase();
  return Object.entries(headers).find(([key])=>key.toLowerCase()===target)?.[1];
};
const eventMarker=(eventId:string)=>'stripe-event:'+eventId;
const ensureCustomerBinding=async(customerId:string,userId:string,allowCreate:boolean)=>{
  const existing=(await db.list<CustomerBinding>(customerBindingTable(customerId),{limit:2})).items;
  if(existing.length){if(existing.some(binding=>binding.userId!==userId))throw new Error('stripe_customer_tenant_mismatch');return}
  if(!allowCreate)throw new Error('stripe_customer_binding_missing');
  const [id]=await db.add(customerBindingTable(customerId),[{customerId,userId,boundAt:new Date().toISOString()}]);
  if(!id)throw new Error('stripe_customer_binding_failed');
};

export const billingSnapshot=async(userId:string)=>{
  const configured=await billingConfigured(),record=await currentBilling(userId);
  return{
    configured,
    plan:record&&ACTIVE_STATUSES.has(record.status)&&!!record.priceId&&APPROVED_PRICE_IDS.has(record.priceId)?'PRO':'FREE',
    status:record?.status||'inactive',
    cadence:record?.cadence||null,
    currentPeriodEnd:record?.currentPeriodEnd||null,
    cancelAtPeriodEnd:!!record?.cancelAtPeriodEnd,
    hasCustomer:!!record?.customerId
  };
};

export const hasProEntitlement=async(userId:string)=>{
  const record=await currentBilling(userId);
  return !!record&&ACTIVE_STATUSES.has(record.status)&&!!record.priceId&&APPROVED_PRICE_IDS.has(record.priceId);
};

export const createCheckout=async(userId:string,email:string|undefined,cadence:unknown)=>{
  if(!await billingConfigured())return error('Stripe billing is not configured',503);
  if(cadence!=='monthly'&&cadence!=='annual')return error('Choose monthly or annual billing',400);
  const current=await currentBilling(userId),stripe=await stripeClient();
  if(current&&CHECKOUT_BLOCKED_STATUSES.has(current.status))return error('An existing Stripe subscription or completed Checkout requires attention before another subscription can be created',409);
  if(current?.status==='checkout_pending'&&current.lastCheckoutSessionId){
    const previous=await stripe.checkout.sessions.retrieve(current.lastCheckoutSessionId);
    if(previous.status==='complete')return error('Checkout completed. Trialvisor is waiting for Stripe billing confirmation before another subscription can be created',409);
    if(previous.status==='open'){
      if(current.lastCheckoutAt&&Date.now()-new Date(current.lastCheckoutAt).getTime()<15*60*1000)return error('A Checkout session is already open. Return to it or wait before starting another',429);
      await stripe.checkout.sessions.expire(current.lastCheckoutSessionId);
    }
  }
  if(current?.lastCheckoutAt&&Date.now()-new Date(current.lastCheckoutAt).getTime()<60000)return error('A checkout session was just created. Please wait before trying again.',429);
  const priceId=cadence==='monthly'?STRIPE_PRICE_PRO_MONTHLY:STRIPE_PRICE_PRO_ANNUAL;
  if(current?.customerId)await ensureCustomerBinding(current.customerId,userId,false);
  const params:Stripe.Checkout.SessionCreateParams={
    mode:'subscription',
    line_items:[{price:priceId,quantity:1}],
    client_reference_id:userId,
    success_url:APP_URL+'?billing=success',
    cancel_url:APP_URL+'?billing=cancelled',
    allow_promotion_codes:true,
    metadata:{trialvisor_user_id:userId,trialvisor_plan:'PRO',trialvisor_cadence:cadence},
    subscription_data:{metadata:{trialvisor_user_id:userId,trialvisor_plan:'PRO',trialvisor_cadence:cadence}},
    integration_identifier:'trialvisor_'+randomLetters(8)
  };
  if(current?.customerId)params.customer=current.customerId;
  else if(email)params.customer_email=email;
  const session=await stripe.checkout.sessions.create(params);
  if(!session.url)return error('Stripe did not return a checkout URL',502);
  await saveBilling(userId,{status:'checkout_pending',plan:'FREE',cadence,subscriptionId:'',priceId:'',currentPeriodEnd:'',cancelAtPeriodEnd:false,lastCheckoutAt:new Date().toISOString(),lastCheckoutSessionId:session.id});
  return json({url:session.url});
};

export const createPortal=async(userId:string)=>{
  if(!await billingConfigured())return error('Stripe billing is not configured',503);
  const current=await currentBilling(userId);
  if(!current?.customerId)return error('No Stripe customer exists for this account',409);
  await ensureCustomerBinding(current.customerId,userId,false);
  const stripe=await stripeClient(),session=await stripe.billingPortal.sessions.create({customer:current.customerId,return_url:APP_URL+'?billing=portal'});
  return json({url:session.url});
};

const applyStripeEvent=async(event:Stripe.Event)=>{
  if(event.type==='checkout.session.expired'){const session=event.data.object as Stripe.Checkout.Session,userId=session.client_reference_id||session.metadata?.trialvisor_user_id;if(!userId||session.metadata?.trialvisor_plan!=='PRO')return;const prior=await currentBilling(userId);if(!prior||prior.lastCheckoutSessionId!==session.id||(prior.lastCheckoutEventCreated||0)>event.created)return;await saveBilling(userId,{status:'checkout_abandoned',plan:'FREE',lastStripeEventId:event.id,lastStripeEventCreated:event.created,lastCheckoutEventCreated:event.created});return}
  if(event.type==='checkout.session.completed'){
    const session=event.data.object as Stripe.Checkout.Session,userId=session.client_reference_id||session.metadata?.trialvisor_user_id;
    if(!userId||session.metadata?.trialvisor_plan!=='PRO')return;
    const prior=await currentBilling(userId),customerId=safeId(session.customer,'cus_');
    if(!customerId)throw new Error('stripe_customer_missing');
    if(!prior||prior.lastCheckoutSessionId!==session.id)throw new Error('stripe_checkout_session_mismatch');
    if((prior.lastCheckoutEventCreated||0)>event.created)return;
    if(prior.customerId&&prior.customerId!==customerId)throw new Error('stripe_customer_ownership_mismatch');
    await ensureCustomerBinding(customerId,userId,true);
    await saveBilling(userId,{customerId,subscriptionId:safeId(session.subscription,'sub_'),status:'pending',plan:'FREE',cadence:session.metadata?.trialvisor_cadence==='annual'?'annual':'monthly',lastStripeEventId:event.id,lastStripeEventCreated:event.created,lastCheckoutEventCreated:event.created});
    await billingNotice(userId,'Checkout completed','Trialvisor is waiting for Stripe’s signed subscription event before activating paid access.','info');
    return;
  }
  if(event.type==='customer.subscription.created'||event.type==='customer.subscription.updated'||event.type==='customer.subscription.deleted'){
    const subscription=event.data.object as Stripe.Subscription,userId=subscription.metadata?.trialvisor_user_id;
    if(!userId||subscription.metadata?.trialvisor_plan!=='PRO')return;
    const prior=await currentBilling(userId),customerId=safeId(subscription.customer,'cus_');
    if(!customerId)throw new Error('stripe_customer_missing');
    if(!prior?.lastCheckoutSessionId)throw new Error('stripe_checkout_record_missing');
    if((prior.lastSubscriptionEventCreated||0)>event.created)return;
    if(prior.customerId&&prior.customerId!==customerId)throw new Error('stripe_customer_ownership_mismatch');
    if(prior.subscriptionId&&prior.subscriptionId!==subscription.id)throw new Error('stripe_subscription_ownership_mismatch');
    await ensureCustomerBinding(customerId,userId,true);
    const item=subscription.items.data[0],price=item?.price,recognized=price?.id===STRIPE_PRICE_PRO_MONTHLY||price?.id===STRIPE_PRICE_PRO_ANNUAL,cadence=price?.id===STRIPE_PRICE_PRO_ANNUAL?'annual':'monthly',active=recognized&&ACTIVE_STATUSES.has(subscription.status);
    if(!recognized){await saveBilling(userId,{customerId,subscriptionId:subscription.id,status:'unrecognized_price',plan:'FREE',priceId:price?.id,lastStripeEventId:event.id,lastStripeEventCreated:event.created,lastSubscriptionEventCreated:event.created});await billingNotice(userId,'Billing configuration review required','Stripe reported a subscription Price that is not approved for Trialvisor Pro. Paid access was not granted.','critical');return}
    await saveBilling(userId,{customerId,subscriptionId:subscription.id,status:subscription.status,plan:active?'PRO':'FREE',cadence,priceId:price.id,currentPeriodEnd:periodEnd(item?.current_period_end),cancelAtPeriodEnd:subscription.cancel_at_period_end,lastStripeEventId:event.id,lastStripeEventCreated:event.created,lastSubscriptionEventCreated:event.created});
    if(prior?.status!==subscription.status){if(subscription.status==='past_due'||subscription.status==='unpaid'){await billingNotice(userId,'Billing action required','Update your payment method to keep Trialvisor protection features active.','critical');await notifications.send({userIds:[userId],notification:{title:'Billing action required',body:'Update your payment method to keep Trialvisor protection features active.'},data:{kind:'billing',status:subscription.status}})}else if(active)await billingNotice(userId,'Trialvisor Pro active','Paid access was activated only after Stripe’s signed subscription event was verified.','success');else if(event.type==='customer.subscription.deleted')await billingNotice(userId,'Paid plan ended','Trialvisor Pro is no longer active. Your retained account data remains available under the current free-plan rules.','warning')}
    return;
  }
  if(event.type==='invoice.payment_failed'){const invoice=event.data.object as unknown as {customer?:string;parent?:{subscription_details?:{metadata?:Record<string,string>}}},metadata=invoice.parent?.subscription_details?.metadata,userId=metadata?.trialvisor_user_id,customerId=safeId(invoice.customer,'cus_');if(userId&&customerId&&metadata?.trialvisor_plan==='PRO'){const prior=await currentBilling(userId);if(!prior?.lastCheckoutSessionId)throw new Error('stripe_checkout_record_missing');if((prior.lastInvoiceEventCreated||0)>event.created)return;if(prior.customerId&&prior.customerId!==customerId)throw new Error('stripe_customer_ownership_mismatch');await ensureCustomerBinding(customerId,userId,true);await saveBilling(userId,{customerId,status:'past_due',plan:'FREE',lastStripeEventId:event.id,lastStripeEventCreated:event.created,lastInvoiceEventCreated:event.created});await billingNotice(userId,'Payment failed','Trialvisor could not renew your paid plan. Open Plan & billing to update payment details.','critical');await notifications.send({userIds:[userId],notification:{title:'Payment failed',body:'Trialvisor could not renew your paid plan. Open Plan & billing to update payment details.'},data:{kind:'billing',status:'past_due'}})}}
};

export const handleStripeWebhook=async(event:any)=>{
  const signature=header(event,'stripe-signature'),body=rawBody(event);
  if(!signature||!body)return error('Missing Stripe webhook signature',400);
  if(body.length>512000)return error('Stripe webhook payload is too large',413);
  if(!await billingConfigured())return error('Stripe billing is not configured',503);
  const stripe=await stripeClient(),endpointSecret=await secrets.readSecret('STRIPE_WEBHOOK_SECRET');
  let stripeEvent:Stripe.Event;
  try{stripeEvent=stripe.webhooks.constructEvent(body,signature,endpointSecret)}catch{console.warn('Stripe webhook signature verification failed');return error('Invalid Stripe webhook signature',400)}
  const marker=eventMarker(stripeEvent.id),seen=(await db.list(marker,{limit:1})).items;
  if(seen.length)return json({received:true,duplicate:true});
  await applyStripeEvent(stripeEvent);
  const [saved]=await db.add(marker,[{eventId:stripeEvent.id,type:stripeEvent.type,processedAt:new Date().toISOString()}]);
  if(!saved)throw new Error('stripe_event_marker_failed');
  return json({received:true});
};
