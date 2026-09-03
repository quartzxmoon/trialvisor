import Stripe from 'stripe';
import { db, error, json, notifications, secrets } from '@appdeploy/sdk';

const APP_URL='https://trialvisor-m8vrsu.v2.appdeploy.ai/';
const REQUIRED_SECRETS=['STRIPE_RESTRICTED_KEY','STRIPE_WEBHOOK_SECRET','STRIPE_PRICE_PRO_MONTHLY','STRIPE_PRICE_PRO_ANNUAL'];
const ACTIVE_STATUSES=new Set(['active','trialing']);

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
  updatedAt:string;
};

const billingTable=(userId:string)=>'billing:'+userId;
const stripeClient=async()=>new Stripe(await secrets.readSecret('STRIPE_RESTRICTED_KEY'),{
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

export const billingSnapshot=async(userId:string)=>{
  const configured=await billingConfigured(),record=await currentBilling(userId);
  return{
    configured,
    plan:record&&ACTIVE_STATUSES.has(record.status)?'PRO':'FREE',
    status:record?.status||'inactive',
    cadence:record?.cadence||null,
    currentPeriodEnd:record?.currentPeriodEnd||null,
    cancelAtPeriodEnd:!!record?.cancelAtPeriodEnd,
    hasCustomer:!!record?.customerId
  };
};

export const createCheckout=async(userId:string,email:string|undefined,cadence:unknown)=>{
  if(!await billingConfigured())return error('Stripe billing is not configured',503);
  if(cadence!=='monthly'&&cadence!=='annual')return error('Choose monthly or annual billing',400);
  const current=await currentBilling(userId);
  if(current&&ACTIVE_STATUSES.has(current.status))return error('An active subscription already exists',409);
  const priceSecret=cadence==='monthly'?'STRIPE_PRICE_PRO_MONTHLY':'STRIPE_PRICE_PRO_ANNUAL';
  const priceId=await secrets.readSecret(priceSecret),stripe=await stripeClient();
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
  return json({url:session.url});
};

export const createPortal=async(userId:string)=>{
  if(!await billingConfigured())return error('Stripe billing is not configured',503);
  const current=await currentBilling(userId);
  if(!current?.customerId)return error('No Stripe customer exists for this account',409);
  const stripe=await stripeClient(),session=await stripe.billingPortal.sessions.create({customer:current.customerId,return_url:APP_URL+'?billing=portal'});
  return json({url:session.url});
};

const applyStripeEvent=async(event:Stripe.Event)=>{
  if(event.type==='checkout.session.completed'){
    const session=event.data.object as Stripe.Checkout.Session,userId=session.client_reference_id||session.metadata?.trialvisor_user_id;
    if(!userId)return;
    await saveBilling(userId,{customerId:safeId(session.customer,'cus_'),subscriptionId:safeId(session.subscription,'sub_'),status:'pending',plan:'FREE',cadence:session.metadata?.trialvisor_cadence==='annual'?'annual':'monthly'});
    return;
  }
  if(event.type==='customer.subscription.created'||event.type==='customer.subscription.updated'||event.type==='customer.subscription.deleted'){
    const subscription=event.data.object as Stripe.Subscription,userId=subscription.metadata?.trialvisor_user_id;
    if(!userId)return;
    const price=subscription.items.data[0]?.price,cadence=price?.recurring?.interval==='year'?'annual':'monthly',active=ACTIVE_STATUSES.has(subscription.status);
    await saveBilling(userId,{customerId:safeId(subscription.customer,'cus_'),subscriptionId:subscription.id,status:subscription.status,plan:active?'PRO':'FREE',cadence,priceId:price?.id,currentPeriodEnd:periodEnd((subscription as unknown as {current_period_end?:number}).current_period_end),cancelAtPeriodEnd:subscription.cancel_at_period_end});
    if(subscription.status==='past_due'||subscription.status==='unpaid')await notifications.send({userIds:[userId],notification:{title:'Billing action required',body:'Update your payment method to keep Trialvisor protection features active.'},data:{kind:'billing',status:subscription.status}});
    return;
  }
  if(event.type==='invoice.payment_failed'){
    const invoice=event.data.object as unknown as {parent?:{subscription_details?:{metadata?:Record<string,string>}}},userId=invoice.parent?.subscription_details?.metadata?.trialvisor_user_id;
    if(userId)await notifications.send({userIds:[userId],notification:{title:'Payment failed',body:'Trialvisor could not renew your paid plan. Open Plan & billing to update payment details.'},data:{kind:'billing',status:'past_due'}});
  }
};

export const handleStripeWebhook=async(event:any)=>{
  const signature=header(event,'stripe-signature'),body=rawBody(event);
  if(!signature||!body)return error('Missing Stripe webhook signature',400);
  if(body.length>512000)return error('Stripe webhook payload is too large',413);
  if(!await billingConfigured())return error('Stripe billing is not configured',503);
  const stripe=await stripeClient(),endpointSecret=await secrets.readSecret('STRIPE_WEBHOOK_SECRET');
  let stripeEvent:Stripe.Event;
  try{stripeEvent=stripe.webhooks.constructEvent(body,signature,endpointSecret)}catch{return error('Invalid Stripe webhook signature',400)}
  const marker=eventMarker(stripeEvent.id),seen=(await db.list(marker,{limit:1})).items;
  if(seen.length)return json({received:true,duplicate:true});
  await applyStripeEvent(stripeEvent);
  const [saved]=await db.add(marker,[{eventId:stripeEvent.id,type:stripeEvent.type,processedAt:new Date().toISOString()}]);
  if(!saved)throw new Error('stripe_event_marker_failed');
  return json({received:true});
};
