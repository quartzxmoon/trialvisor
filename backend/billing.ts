import Stripe from 'stripe';
import { db, error, json, notifications, secrets } from '@appdeploy/sdk';

const APP_URL='https://trialvisor-m8vrsu.v2.appdeploy.ai/';
const STRIPE_PRICE_PRO_MONTHLY='price_1UBuOfGTXvZ0TX3Afx0TbBsm';
const STRIPE_PRICE_PRO_ANNUAL='price_1UBuSLGTXvZ0TX3AtAl720ek';
const REQUIRED_SECRETS=['STRIPE_RESTRICTED_KEY','STRIPE_WEBHOOK_SECRET'];
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
  lastCheckoutAt?:string;
  lastCheckoutSessionId?:string;
  lastStripeEventId?:string;
  lastStripeEventCreated?:number;
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
  if(current?.lastCheckoutAt&&Date.now()-new Date(current.lastCheckoutAt).getTime()<60000)return error('A checkout session was just created. Please wait before trying again.',429);
  const priceId=cadence==='monthly'?STRIPE_PRICE_PRO_MONTHLY:STRIPE_PRICE_PRO_ANNUAL,stripe=await stripeClient();
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
  await saveBilling(userId,{status:'checkout_pending',plan:'FREE',cadence,lastCheckoutAt:new Date().toISOString(),lastCheckoutSessionId:session.id});
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
  if(event.type==='checkout.session.expired'){
    const session=event.data.object as Stripe.Checkout.Session,userId=session.client_reference_id||session.metadata?.trialvisor_user_id;
    if(!userId)return;
    const prior=await currentBilling(userId);
    if(prior?.lastStripeEventId===event.id||(prior?.lastStripeEventCreated||0)>event.created)return;
    if(prior?.lastCheckoutSessionId!==session.id)return;
    await saveBilling(userId,{status:'checkout_abandoned',plan:'FREE',lastStripeEventId:event.id,lastStripeEventCreated:event.created});
    return;
  }
  if(event.type==='checkout.session.completed'){
    const session=event.data.object as Stripe.Checkout.Session,userId=session.client_reference_id||session.metadata?.trialvisor_user_id;
    if(!userId)return;
    const prior=await currentBilling(userId),customerId=safeId(session.customer,'cus_');
    if(!customerId)throw new Error('stripe_customer_missing');
    if(prior?.lastStripeEventId===event.id||(prior?.lastStripeEventCreated||0)>event.created)return;
    if(prior?.customerId&&customerId&&prior.customerId!==customerId)throw new Error('stripe_customer_ownership_mismatch');
    await ensureCustomerBinding(customerId,userId,true);
    await saveBilling(userId,{customerId,subscriptionId:safeId(session.subscription,'sub_'),status:'pending',plan:'FREE',cadence:session.metadata?.trialvisor_cadence==='annual'?'annual':'monthly',lastStripeEventId:event.id,lastStripeEventCreated:event.created});
    await billingNotice(userId,'Checkout completed','Trialvisor is waiting for Stripeâ€™s signed subscription event before activating paid access.','info');
    return;
  }
  if(event.type==='customer.subscription.created'||event.type==='customer.subscription.updated'||event.type==='customer.subscription.deleted'){
    const subscription=event.data.object as Stripe.Subscription,userId=subscription.metadata?.trialvisor_user_id;
    if(!userId)return;
    const prior=await currentBilling(userId),customerId=safeId(subscription.customer,'cus_');
    if(!customerId)throw new Error('stripe_customer_missing');
    if(prior?.lastStripeEventId===event.id||(prior?.lastStripeEventCreated||0)>event.created)return;
    if(prior?.customerId&&customerId&&prior.customerId!==customerId)throw new Error('stripe_customer_ownership_mismatch');
    await ensureCustomerBinding(customerId,userId,false);
    const price=subscription.items.data[0]?.price,recognized=price?.id===STRIPE_PRICE_PRO_MONTHLY||price?.id===STRIPE_PRICE_PRO_ANNUAL,cadence=price?.id===STRIPE_PRICE_PRO_ANNUAL?'annual':'monthly',active=recognized&&ACTIVE_STATUSES.has(subscription.status);
    if(!recognized){await saveBilling(userId,{customerId,subscriptionId:subscription.id,status:'unrecognized_price',plan:'FREE',priceId:price?.id,lastStripeEventId:event.id,lastStripeEventCreated:event.created});await billingNotice(userId,'Billing configuration review required','Stripe reported a subscription Price that is not approved for Trialvisor Pro. Paid access was not granted.','critical');return}
    await saveBilling(userId,{customerId,subscriptionId:subscription.id,status:subscription.status,plan:active?'PRO':'FREE',cadence,priceId:price.id,currentPeriodEnd:periodEnd((subscription as unknown as {current_period_end?:number}).current_period_end),cancelAtPeriodEnd:subscription.cancel_at_period_end,lastStripeEventId:event.id,lastStripeEventCreated:event.created});
    if(prior?.status!==subscription.status){if(subscription.status==='past_due'||subscription.status==='unpaid'){await billingNotice(userId,'Billing action required','Update your payment method to keep Trialvisor protection features active.','critical');await notifications.send({userIds:[userId],notificawz÷»h‘éì¶»§q«^u½Ñ¥”¹Í•Ù•É¥Ñäµ¥¹™½í‰½É‘•Èµ±•™Ðµ½±½ÈèŒÌäÜÕˆåô¹¹½Ñ¥”¹¥ÌµÉ•…‘í½Á…¥Ñäè¸ÜÙô¹¹½Ñ¥”µ¥½¹íÝ¥‘Ñ èÌáÁàí¡•¥¡ÐèÌáÁàí‘¥ÍÁ±…äéÉ¥íÁ±…”µ¥Ñ•µÌé•¹Ñ•Èí‰½É‘•ÈµÉ…‘¥ÕÌèÄÁÁàí‰…­É½Õ¹è•™˜Õ™„í½±½ÈèŒÌÄÕˆÝ‘ô¹¹½Ñ¥”µ¥½¸ÍÙíÝ¥‘Ñ èÄåÁáô¹¹½Ñ¥”µµ•Ñ…í‘¥ÍÁ±…äé™±•àí…ÀèåÁàí…±¥¸µ¥Ñ•µÌé•¹Ñ•Èí™±•àµÝÉ…ÀéÝÉ…Àí™½¹ÐµÍ¥é”èåÁàíÑ•áÐµÑÉ…¹Í™½É´éÕÁÁ•É…Í”í±•ÑÑ•ÈµÍÁ…¥¹œè¸Àá•´í½±½ÈèŒÜÄàÈäÙô¹¹½Ñ¥”µµ•Ñ„¥í™½¹ÐµÍÑå±”é¹½Éµ…°í½±½ÈèŒÄÜØå”Àí™½¹ÐµÝ•¥¡ÐèàÀÁô¹¹½Ñ¥” Íí™½¹ÐèÜÀÀ€ÄÙÁà5…¹É½Á”íµ…É¥¸èÝÁà€À€ÑÁáô¹¹½Ñ¥”Áí™½¹ÐµÍ¥é”èÄÍÁàí½±½ÈèŒØÄÜÔàäí±¥¹”µ¡•¥¡ÐèÄ¸ÔÔíµ…É¥¸èÁô¹¹½Ñ¥”Íµ…±±í‘¥ÍÁ±…äé‰±½¬íµ…É¥¸µÑ½ÀèÝÁàí½±½ÈèŒÐÐÕ˜Üåô¹¹½Ñ¥”µ…Ñ¥½¹Íí‘¥ÍÁ±…äé™±•àí…ÀèÝÁàí™±•àµÝÉ…ÀéÝÉ…Áô¹¹½Ñ¥”µ…Ñ¥½¹Ìù‰ÕÑÑ½¹í™½¹ÐµÍ¥é”èÄÅÁàíµ…É¥¸èÀíÁ…‘‘¥¹œèáÁà€ÄÁÁáô¹Ñ¥µ•±¥¹•í‘¥ÍÁ±…äéÉ¥í…ÀèÀí‰…­É½Õ¹è™™˜í‰½É‘•ÈèÅÁàÍ½±¥€‘”Õ•˜í‰½É‘•ÈµÉ…‘¥ÕÌèÄÙÁàíÁ…‘‘¥¹œèÄÁÁà€ÈÑÁáô¹Ñ¥µ•±¥¹”…ÉÑ¥±•í‘¥ÍÁ±…äéÉ¥íÉ¥µÑ•µÁ±…Ñ”µ½±Õµ¹ÌèÄáÁà€Å™Èí…ÀèÄÑÁàíÁ…‘‘¥¹œèÄáÁà€Àí‰½É‘•Èµ‰½ÑÑ½´èÅÁàÍ½±¥€”Ù•‰˜Åô¹Ñ¥µ•±¥¹”…ÉÑ¥±”é±…ÍÐµ¡¥±‘í‰½É‘•Èµ‰½ÑÑ½´èÁô¹Ñ¥µ•±¥¹”µ‘½ÑíÝ¥‘Ñ èÄÅÁàí¡•¥¡ÐèÄÅÁàí‰½É‘•ÈµÉ…‘¥ÕÌèÔÀ”í‰…­É½Õ¹èŒÔØàÕˆÔíµ…É¥¸µÑ½ÀèÕÁàí‰½àµÍ¡…‘½ÜèÀ€À€À€ÑÁà€”å˜Å˜áô¹Ñ¥µ•±¥¹”µ‘½Ð¹…Ñ½ÈµÕÍ•Èµ…Ñ¥½¹í‰…­É½Õ¹èŒÄÜØå”Áô¹Ñ¥µ•±¥¹”µ‘½Ð¹…Ñ½ÈµÑÉ¥…±Ù¥Í½Èµ…Ñ¥½¹í‰…­É½Õ¹èŒÄØáŒáô¹Ñ¥µ•±¥¹”µ‘½Ð¹…Ñ½ÈµÁÉ½Ù¥‘•ÈµÉ•ÍÕ±Ñí‰…­É½Õ¹è„ØÕ„ÐÍô¹Ñ¥µ•±¥¹”µµ•Ñ…í‘¥ÍÁ±…äé™±•àí…ÀèÄÉÁàí…±¥¸µ¥Ñ•µÌé•¹Ñ•Èí™±•àµÝÉ…ÀéÝÉ…Áô¹Ñ¥µ•±¥¹”µµ•Ñ„‰í™½¹ÐµÍ¥é”èåÁàí±•ÑÑ•ÈµÍÁ…¥¹œè¸ÄÅ•´í½±½ÈèŒÔÔÜÀàÝô¹Ñ¥µ•±¥¹”µµ•Ñ„Ñ¥µ•í™½¹ÐµÍ¥é”èÄÅÁàí½±½ÈèŒàÐäÉ„Åô¹Ñ¥µ•±¥¹” Íí™½¹ÐèÜÀÀ€ÄÕÁà5…¹É½Á”íµ…É¥¸èÙÁà€À€ÑÁáô¹Ñ¥µ•±¥¹”Áí™½¹ÐµÍ¥é”èÄÉÁàí±¥¹”µ¡•¥¡ÐèÄ¸ÔÔí½±½ÈèŒØØÜäáŒíµ…É¥¸èÁô¹Ñ¥µ•±¥¹”µ±¥¹­í‰…­É½Õ¹éÑÉ…¹ÍÁ…É•¹Ðí½±½ÈèŒÄÜØå”ÀíÁ…‘‘¥¹œèáÁà€Àí™½¹ÐµÍ¥é”èÄÅÁàí™½¹ÐµÝ•¥¡ÐèÜÀÁô¹½µÁ…ÐµÑ¥µ•±¥¹•í‰½É‘•ÈèÀíÁ…‘‘¥¹œèÕÁà€ÑÁàí‰…­É½Õ¹éÑÉ…¹ÍÁ…É•¹Ñô¹½µÁ…ÐµÑ¥µ•±¥¹”…ÉÑ¥±•íÁ…‘‘¥¹œèÄÍÁà€Áô(¹‘…Ñ„µµ…ÑÉ¥áí‘¥ÍÁ±…äéÉ¥íÉ¥µÑ•µÁ±…Ñ”µ½±Õµ¹ÌéÉ•Á•…Ð Ð°Å™È¤í…ÀèÄÉÁàíµ…É¥¸µ‰½ÑÑ½´èÄáÁáô¹‘…Ñ„µµ…ÑÉ¥à…ÉÑ¥±”°¹Í•ÑÑ¥¹ÌµÁ…¹•±í‰…­É½Õ¹è™™˜í‰½É‘•ÈèÅÁàÍ½±¥€‘”Õ•˜í‰½É‘•ÈµÉ…‘¥ÕÌèÄÕÁàíÁ…‘‘¥¹œèÈÁÁáô¹‘…Ñ„µµ…ÑÉ¥àÍÙí½±½ÈèŒÄØàÔá…ô¹‘…Ñ„µµ…ÑÉ¥à Ì°¹Í•ÑÑ¥¹ÌµÁ…¹•° Íí™½¹ÐèÜÀÀ€ÄÙÁà5…¹É½Á”íµ…É¥¸èÄÅÁà€À€ÙÁáô¹‘…Ñ„µµ…ÑÉ¥àÀ°¹Í•ÑÑ¥¹ÌµÁ…¹•°Áí™½¹ÐµÍ¥é”èÄÉÁàí±¥¹”µ¡•¥¡ÐèÄ¸ÔÔí½±½ÈèŒØäÝŒá”íµ…É¥¸èÁô¹Í•ÑÑ¥¹ÌµÁ…¹•±íµ…É¥¸µÑ½ÀèÄÑÁáô¹Í•ÑÑ¥¹Ìµ½¹¹•Ñ¥½¹í‘¥ÍÁ±…äé™±•àí©ÕÍÑ¥™äµ½¹Ñ•¹ÐéÍÁ…”µ‰•ÑÝ••¸í…ÀèÈÁÁàí…±¥¸µ¥Ñ•µÌé•¹Ñ•ÈíÁ…‘‘¥¹œèÄÑÁà€Àí‰½É‘•ÈµÑ½ÀèÅÁàÍ½±¥€”Õ•‰˜Åô¹Í•ÑÑ¥¹Ìµ½¹¹•Ñ¥½¸ˆ°¹Í•ÑÑ¥¹Ìµ½¹¹•Ñ¥½¸ÍÁ…¸°¹Í•ÑÑ¥¹Ìµ½¹¹•Ñ¥½¸Íµ…±±í‘¥ÍÁ±…äé‰±½­ô¹Í•ÑÑ¥¹Ìµ½¹¹•Ñ¥½¸ÍÁ…¸°¹Í•ÑÑ¥¹Ìµ½¹¹•Ñ¥½¸Íµ…±±í™½¹ÐµÍ¥é”èÄÅÁàí½±½ÈèŒÙ„ÝäÀíµ…É¥¸µÑ½ÀèÍÁáô¹Í•ÑÑ¥¹Ìµ½¹¹•Ñ¥½¸ù‘¥Øé±…ÍÐµ¡¥±‘í‘¥ÍÁ±…äé™±•àí…±¥¸µ¥Ñ•µÌé•¹Ñ•Èí…ÀèáÁáô¹Í•ÑÑ¥¹Ìµ¹½Ñ•í‰½É‘•ÈµÑ½ÀèÅÁàÍ½±¥€”Õ•‰˜ÄíÁ…‘‘¥¹œµÑ½ÀèÄÉÁà…¥µÁ½ÉÑ…¹Ñô¹½¹ÑÉ½±ÌµÉ½Ü°¹‘…¹•ÈµÁ…¹•±í‘¥ÍÁ±…äé™±•àí…±¥¸µ¥Ñ•µÌé•¹Ñ•Èí©ÕÍÑ¥™äµ½¹Ñ•¹ÐéÍÁ…”µ‰•ÑÝ••¸í…ÀèÈÑÁáô¹½¹ÑÉ½±ÌµÉ½Üù‘¥Ø°¹‘…¹•ÈµÁ…¹•°ù‘¥Ø°¹™••‘‰…¬µÁ…¹•°ù‘¥Ùí‘¥ÍÁ±…äé™±•àí…ÀèÄÍÁàí…±¥¸µ¥Ñ•µÌé™±•àµÍÑ…ÉÑô¹½¹ÑÉ½±ÌµÉ½ÜÍÙœ°¹‘…¹•ÈµÁ…¹•°ÍÙœ°¹™••‘‰…¬µÁ…¹•°ù‘¥ØùÍÙí™±•àèÀ€À…ÕÑ¼í½±½ÈèŒÄØàÔá…ô¹‘…¹•ÈµÁ…¹•±í‰½É‘•Èµ½±½Èè•™Œåô¹‘…¹•ÈµÁ…¹•°ÍÙí½±½Èè…ÑÐÍô¹‘•±•Ñ”µ½¹™¥Éµíµ…àµÝ¥‘Ñ èÌÈÁÁàí‘¥ÍÁ±…äéÉ¥íÉ¥µÑ•µÁ±…Ñ”µ½±Õµ¹ÌèÅ™È€Å™Èí…ÀèáÁáô¹‘•±•Ñ”µ½¹™¥É´ˆ°¹‘•±•Ñ”µ½¹™¥É´ÍÁ…¹íÉ¥µ½±Õµ¸èÄ¼´Åô¹‘•±•Ñ”µ½¹™¥É´ÍÁ…¹í™½¹ÐµÍ¥é”èÄÅÁàí½±½ÈèŒÝ„ÔÄÑô¹‘…¹•Èµ‰ÕÑÑ½¹í‰…­É½Õ¹è„àÍ˜Ìäí½±½Èè™™˜í‰½É‘•ÈµÉ…‘¥ÕÌèåÁàíÁ…‘‘¥¹œèÄÁÁàí™½¹ÐµÝ•¥¡ÐèÜÀÁô¹™••‘‰…¬µÁ…¹•±í‘¥ÍÁ±…äéÉ¥íÉ¥µÑ•µÁ±…Ñ”µ½±Õµ¹Ìè¸Ý™È€Ä¸Í™Èí…ÀèÈÑÁáô¹™••‘‰…¬µÁ…¹•°™½Éµí‰½É‘•ÈèÀíÁ…‘‘¥¹œèÁô¹™••‘‰…¬µÁ…¹•°™½É´‰ÕÑÑ½¹í©ÕÍÑ¥™äµÍ•±˜éÍÑ…ÉÑô¹¹…Ø°¹ÁÕ‰±¥Œµ¡•…‰ÕÑÑ½¸°¹ÁÕ‰±¥Œµ…±±½ÕÐ‰ÕÑÑ½¸°¹É•Á½ÉÐµ™½É´‰ÕÑÑ½¸°¹™••‘‰…¬µÁ…¹•°‰ÕÑÑ½¸°¹¹½Ñ¥”‰ÕÑÑ½¸°¹Í•ÑÑ¥¹ÌµÁ…¹•°‰ÕÑÑ½¹íµ¥¸µ¡•¥¡ÐèÐÑÁáõÍ•±•Ðé™½ÕÌµÙ¥Í¥‰±”±Ñ•áÑ…É•„é™½ÕÌµÙ¥Í¥‰±”±ÍÕµµ…Éäé™½ÕÌµÙ¥Í¥‰±”±„é™½ÕÌµÙ¥Í¥‰±•í½ÕÑ±¥¹”èÍÁàÍ½±¥€Œàáˆá™˜í½ÕÑ±¥¹”µ½™™Í•ÐèÉÁáô)µ•‘¥„¡µ…àµÝ¥‘Ñ èÄÀÀÁÁà¥ì¹±¥™•å±”µÉ¥‘íÉ¥µÑ•µÁ±…Ñ”µ½±Õµ¹ÌéÉ•Á•…Ð È°Å™È¥ô¹ÁÕ‰±¥Œµ™½½Ñ•ÉíÉ¥µÑ•µÁ±…Ñ”µ½±Õµ¹ÌèÅ™È€Å™Éô¹‘…Ñ„µµ…ÑÉ¥áíÉ¥µÑ•µÁ±…Ñ”µ½±Õµ¹ÌèÅ™È€Å™Éô¹Í•ÕÉ¥ÑäµÉ•Á½ÉÐ°¹™••‘‰…¬µÁ…¹•±íÉ¥µÑ•µÁ±…Ñ”µ½±Õµ¹ÌèÅ™Éõô)µ•‘¥„¡µ…àµÝ¥‘Ñ èÜÀÁÁà¥ì¹ÁÕ‰±¥Œµ¡•…‘í¡•¥¡Ðé…ÕÑ¼íµ¥¸µ¡•¥¡ÐèÜÁÁàíÁ…‘‘¥¹œèÄÉÁà€ÄÙÁáô¹ÁÕ‰±¥Œµ¡•…€¹Ý½É‘µ…É­íÝ¥‘Ñ èÄÐÕÁáô¹ÁÕ‰±¥Œµ¡•…¹…Ùí…ÀèáÁáô¹ÁÕ‰±¥Œµ¡•…¹…Ø…í‘¥ÍÁ±…äé¹½¹•ô¹ÁÕ‰±¥Œµ¡•É½íÁ…‘‘¥¹œèÔáÁà€ÈÁÁà€ÌÑÁáô¹±¥™•å±”µÉ¥°¹ÑÉÕÑ µÉ¥°¹ÁÉ½Ù¥‘•Èµ±••¹‘íÉ¥µÑ•µÁ±…Ñ”µ½±Õµ¹ÌèÅ™ÈíÁ…‘‘¥¹œµ±•™ÐèÄÙÁàíÁ…‘‘¥¹œµÉ¥¡ÐèÄÙÁáô¹Í•ÕÉ¥Ñäµ±¥ÍÐ°¹ÍÕ‰ÁÉ½•ÍÍ½Èµ±¥ÍÐ°¹Í•ÕÉ¥ÑäµÉ•Á½ÉÑíÁ…‘‘¥¹œµ±•™ÐèÄÙÁàíÁ…‘‘¥¹œµÉ¥¡ÐèÄÙÁáô¹ÁÕ‰±¥Œµ…±±½ÕÑíµ…É¥¸µ±•™ÐèÄÙÁàíµ…É¥¸µÉ¥¡ÐèÄÙÁáô¹ÁÕ‰±¥Œµ™½½Ñ•ÉíÉ¥µÑ•µÁ±…Ñ”µ½±Õµ¹ÌèÅ™ÈíÁ…‘‘¥¹œèÌÑÁà€ÈÉÁáô¹¹½Ñ¥•íÉ¥µÑ•µÁ±…Ñ”µ½±Õµ¹ÌèÌáÁà€Å™Éô¹¹½Ñ¥”µ…Ñ¥½¹ÍíÉ¥µ½±Õµ¸èÉô¹‘…Ñ„µµ…ÑÉ¥áíÉ¥µÑ•µÁ±…Ñ”µ½±Õµ¹ÌèÅ™Éô¹½¹ÑÉ½±ÌµÉ½Ü°¹‘…¹•ÈµÁ…¹•°°¹Í•ÑÑ¥¹Ìµ½¹¹•Ñ¥½¹í…±¥¸µ¥Ñ•µÌé™±•àµÍÑ…ÉÐí™±•àµ‘¥É•Ñ¥½¸é½±Õµ¹ô¹™••‘‰…¬µÁ…¹•±íÉ¥µÑ•µÁ±…Ñ”µ½±Õµ¹ÌèÅ™Éô¹‘•±•Ñ”µ½¹™¥Éµíµ…àµÝ¥‘Ñ é¹½¹•ô¹…Í¥‘”µ¡•±Áíµ…É¥¸µÑ½ÀèÄÁÁáô¹Ñ¥µ•±¥¹•íÁ…‘‘¥¹œèáÁà€ÄÑÁáõô)µ•‘¥„¡ÁÉ•™•ÉÌµÉ•‘Õ•µµ½Ñ¥½¸éÉ•‘Õ”¥ì¨°¨èé‰•™½É”°¨èé…™Ñ•ÉíÍÉ½±°µ‰•¡…Ù¥½Èé…ÕÑ¼…¥µÁ½ÉÑ…¹Ðí…¹¥µ…Ñ¥½¸µ‘ÕÉ…Ñ¥½¸è¸ÀÅµÌ…¥µÁ½ÉÑ…¹Ðí…¹¥µ…Ñ¥½¸µ¥Ñ•É…Ñ¥½¸µ½Õ¹ÐèÄ…¥µÁ½ÉÑ…¹ÐíÑÉ…¹Í¥Ñ¥½¸µ‘ÕÉ…Ñ¥½¸è¸ÀÅµÌ…¥µÁ½ÉÑ…¹Ñõô(