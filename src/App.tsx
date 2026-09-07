import { useEffect, useRef, useState } from 'react';
import { api, auth } from '@appdeploy/client';
import { AlertTriangle, ArrowRight, CalendarClock, Check, CheckCircle2, ChevronRight, CircleDollarSign, Eye, History, Inbox, Link2, LogOut, Mail, Menu, Plus, RefreshCw, ShieldCheck, X } from 'lucide-react';
import { ActivityCenter, DataControls, isPublicInformationPath, NotificationCenter, PublicInformationPage, TrialActivity, type CustomerActivity, type PersistentNotice } from './LaunchSurfaces';

type Trial={id:string;provider:string;plan:string;price:number;currency:string;billingCadence?:'monthly'|'annual'|'unknown';trialEnd:string;safeDeadline:string;plannedExecution:string;providerTrialEndDate?:string;hasExplicitTime?:boolean;hasDetectedChargeDate?:boolean;state:string;tier:string;support?:'GUIDED'|'NOT_SUPPORTED';confidence:number;confidenceBand?:'HIGH'|'MEDIUM'|'LOW';enrollmentStatus?:'ACTIVE'|'POSSIBLE'|'PROMOTIONAL';exposureStatus?:'CONFIRMED'|'UNCONFIRMED'|'EXCLUDED';protectEligible?:boolean;classificationReason?:string;userConfirmedEnrollmentAt?:string;evidence?:string;nextAction?:string;authorizationAt?:string;providerActionAt?:string;cancellationUrl?:string;sourceRef?:{provider:'google'|'microsoft';messageId:string;threadId:string;receivedAt?:string;accountIdentifier?:string};verificationRef?:{provider:'google';messageId:string;threadId:string;receivedAt?:string};activity?:CustomerActivity[]};
type Connection={id?:string;provider:string;providerAccountIdentifier?:string;status:string;lastSync:string;mode:string};
type GmailSyncResult={mode:string;scanned:number;matched:number;created:number;duplicates:number;fetchFailures:number;classification?:{active:number;possible:number;promotional:number};confidence:{high:number;medium:number;low:number};incrementalCandidates:number;searchCandidates:number;capped:boolean;processorVersion:number};
type Snapshot={user:{name?:string;email?:string};account:{initialized:boolean;onboardingComplete:boolean;guidanceShown?:string[]};trials:Trial[];exposure:{confirmed7:number;confirmed30:number;uncertainCount:number;uncertainAmount:number};saved:number;events:number;activity:CustomerActivity[];notifications:PersistentNotice[];connections:Connection[];config:{google:boolean;microsoft:boolean;stripe:boolean;email:boolean};billing:{configured:boolean;plan:'FREE'|'PRO';status:string;cadence:'monthly'|'annual'|null;currentPeriodEnd:string|null;cancelAtPeriodEnd:boolean;hasCustomer:boolean};gmailDiscovery?:{processedReferences:number;matchedReferences:number;promotionalReferences?:number;lastSync:string|null;lastResult?:GmailSyncResult|null;verified:boolean}};
type Modal={kind:'protect'|'decision'|'manual'|'session_warning';trial?:Trial}|null;
type Toast={key:string;text:string}|null;
const money=(n:number)=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(n);
const label=(s:string)=>s.replace(/_/g,' ');
export const formatCalendarDate=(s?:string,options?:Intl.DateTimeFormatOptions,locale?:string)=>{if(!s)return '';const m=s.match(/^(\d{4})-(\d{2})-(\d{2})/);if(m){const [,y,mon,d]=m;const local=new Date(Number(y),Number(mon)-1,Number(d),12,0,0);return local.toLocaleDateString(locale,options||{month:'short',day:'numeric'})}return new Date(s).toLocaleDateString(locale,options||{month:'short',day:'numeric'})};
const day=(s?:string)=>formatCalendarDate(s);
const dateTime=(s:string)=>new Date(s).toLocaleString(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'});
const daysLeft=(s:string)=>Math.max(0,Math.ceil((new Date(s).getTime()-Date.now())/86400000));
const annual=(n:number)=>n*12;
const supportLabel=(t:Trial)=>t.support==='GUIDED'||/\bcanva\b/i.test(t.provider)?'Guided':'Not yet supported';
const guidanceCopy:Record<string,string>={FIRST_AUTHENTICATED_VISIT:'Welcome to Trialvisor. Connect the inboxes you use for subscriptions and we will look for free trials and upcoming charges.',FIRST_ACCOUNT_CONNECTED:'Google connected. Trialvisor can now discover subscription-related signals. Nothing is protected until you choose Protect.',FIRST_TRIAL_DETECTED:'Trial found. Review it before enabling protection. Detection never authorizes cancellation.',FIRST_PROTECT_AUTHORIZATION:'Protection enabled. Trialvisor will monitor the Safe Cancel Deadline and ask before acting.',FIRST_VERIFIED_CANCELLATION:'Cancellation verified. Trialvisor recorded the provider confirmation and avoided charge.'};
const SESSION_IDLE_TIMEOUT_MS=30*60*1000;
const SESSION_WARN_TIMEOUT_MS=25*60*1000;
const HEARTBEAT_THROTTLE_MS=60*1000;
const getStoredSessionId=()=>{try{return localStorage.getItem('trialvisor_session_id')||undefined}catch{return undefined}};
const setStoredSessionId=(sid?:string)=>{try{if(sid)localStorage.setItem('trialvisor_session_id',sid);else localStorage.removeItem('trialvisor_session_id')}catch{}};
function App(){
 const [snap,setSnap]=useState<Snapshot|null>(null),[busy,setBusy]=useState(''),[error,setError]=useState(''),[view,setView]=useState<'overview'|'protection'|'accounts'|'activity'|'notifications'|'settings'|'billing'>('overview'),[modal,setModal]=useState<Modal>(null),[toast,setToast]=useState<Toast>(null),[mobileNav,setMobileNav]=useState(false);
 const lastActivityRef=useRef<number>(Date.now());
 const lastHeartbeatRef=useRef<number>(Date.now());
 const handleSignOut=async(notice?:string)=>{
  try{
   setBusy('signout');
   const sid=getStoredSessionId();
   setStoredSessionId(undefined);
   try{await api.post('/api/auth/session/invalidate',{sessionId:sid},sid?{headers:{'X-Session-Id':sid}}:undefined)}catch{}
   await auth.signOut();
  }catch{}
  setSnap(null);
  setModal(null);
  if(notice)setError(notice);
  setBusy('');
 };
 const staySignedIn=async()=>{
  lastActivityRef.current=Date.now();
  lastHeartbeatRef.current=Date.now();
  setModal(null);
  try{
   const sid=getStoredSessionId();
   await api.post('/api/auth/session/heartbeat',{sessionId:sid},sid?{headers:{'X-Session-Id':sid}}:undefined);
  }catch(e){
   const status=(e as {response?:{status?:number}})?.response?.status;
   if(status===401){
    await handleSignOut('Your session expired for security. Sign in again to continue.');
   }
  }
 };
 const load=async()=>{
  try{
   setError('');
   const sid=getStoredSessionId();
   const request=()=>Promise.race([api.get('/api/dashboard',sid?{headers:{'X-Session-Id':sid}}:undefined),new Promise<never>((_,reject)=>setTimeout(()=>reject(new Error('dashboard_timeout')),15000))]);
   let result;
   try{
    result=await request();
   }catch(firstError){
    const status=(firstError as {response?:{status?:number}})?.response?.status;
    if(status===401){
     await handleSignOut('Your session expired for security. Sign in again to continue.');
     return;
    }
    throw firstError;
   }
   setSnap(result.data);
   lastActivityRef.current=Date.now();
  }catch(e){
   const status=(e as {response?:{status?:number}})?.response?.status;
   if(status===401){
    await handleSignOut('Your session expired for security. Sign in again to continue.');
    return;
   }
   setError('Unable to load your protection center. Select Retry to try again.');
  }
 };
 useEffect(()=>{void(async()=>{try{const user=await auth.getUser();if(user)await load()}catch{setError('Your secure session could not be restored. Sign in again to continue.')}})()},[]);
 useEffect(()=>{
  if(!snap)return;
  const onActivity=()=>{
   lastActivityRef.current=Date.now();
   if(Date.now()-lastHeartbeatRef.current>HEARTBEAT_THROTTLE_MS){
    lastHeartbeatRef.current=Date.now();
    const sid=getStoredSessionId();
    api.post('/api/auth/session/heartbeat',{sessionId:sid},sid?{headers:{'X-Session-Id':sid}}:undefined).catch((e:{response?:{status?:number}})=>{
     if(e?.response?.status===401){
      void handleSignOut('Your session expired for security. Sign in again to continue.');
     }
    });
   }
  };
  const events=['mousedown','keydown','touchstart','scroll'] as const;
  events.forEach(e=>window.addEventListener(e,onActivity,{passive:true}));
  const timer=setInterval(()=>{
   const idle=Date.now()-lastActivityRef.current;
   if(idle>=SESSION_IDLE_TIMEOUT_MS){
    void handleSignOut('Your session expired for security. Sign in again to continue.');
   }else if(idle>=SESSION_WARN_TIMEOUT_MS){
    setModal(m=>m?.kind==='session_warning'?m:{kind:'session_warning'});
   }
  },5000);
  return()=>{
   events.forEach(e=>window.removeEventListener(e,onActivity));
   clearInterval(timer);
  };
 },[snap]);
 useEffect(()=>{
  const onStorage=(e:StorageEvent)=>{
   if(e.key==='trialvisor_session_id'&&!e.newValue&&snap){
    setSnap(null);
    setModal(null);
    setError('Your session expired for security. Sign in again to continue.');
   }
  };
  window.addEventListener('storage',onStorage);
  return()=>window.removeEventListener('storage',onStorage);
 },[snap]);
 useEffect(()=>{const params=new URLSearchParams(window.location.search),billing=params.get('billing'),oauth=params.get('oauth');if(billing==='success')setToast({key:'BILLING_RESULT',text:'Checkout returned successfully. Paid access activates only after Trialvisor verifies Stripe’s signed webhook.'});else if(billing==='cancelled')setToast({key:'BILLING_RESULT',text:'Checkout was cancelled. Your current plan was not changed.'});if(oauth==='google_connected')setToast({key:'OAUTH_RESULT',text:'Google account connected successfully. You can now sync Gmail to discover subscription signals.'});else if(oauth==='google_denied')setError('Google sign-in was canceled or access was denied. No account was connected.');else if(oauth==='google_failed')setError('Google account connection could not be completed safely. Please try connecting again.');if(billing||oauth)window.history.replaceState({},'',window.location.pathname)},[]);
 useEffect(()=>{if(!snap||toast)return;const shown=snap.account.guidanceShown||[];const google=snap.connections.some(x=>x.provider==='Google'&&x.mode==='PRODUCTION');const canceled=snap.trials.some(x=>x.state==='CANCELED_CONFIRMED');const candidates=[!shown.includes('FIRST_AUTHENTICATED_VISIT')&&'FIRST_AUTHENTICATED_VISIT',google&&!shown.includes('FIRST_ACCOUNT_CONNECTED')&&'FIRST_ACCOUNT_CONNECTED',snap.trials.length>0&&!shown.includes('FIRST_TRIAL_DETECTED')&&'FIRST_TRIAL_DETECTED',canceled&&!shown.includes('FIRST_VERIFIED_CANCELLATION')&&'FIRST_VERIFIED_CANCELLATION'].filter(Boolean) as string[];if(candidates[0])showGuidance(candidates[0],guidanceCopy[candidates[0]])},[snap,toast]);
 const markGuidance=async(key:string)=>{try{await api.post('/api/guidance/'+key+'/seen');setSnap(s=>s?{...s,account:{...s.account,guidanceShown:Array.from(new Set([...(s.account.guidanceShown||[]),key]))}}:s)}catch{}};
 const showGuidance=(key:string,text:string)=>{setToast({key,text});void markGuidance(key)};
 const signIn=async()=>{
  try{
   setBusy('signin');
   setError('');
   await auth.signIn();
   try{
    const r=await api.post('/api/auth/session/init');
    if(r?.data?.sessionId)setStoredSessionId(r.data.sessionId);
   }catch{}
   lastActivityRef.current=Date.now();
   lastHeartbeatRef.current=Date.now();
   await load();
  }catch(e){
   const code=(e as {code?:string})?.code;
   setError(code==='popup_blocked'?'Your browser blocked the secure sign-in window. Allow popups and try again.':code==='popup_closed'?'Sign-in was closed before completion. Please try again.':'Sign-in did not complete. Reset the sign-in session and retry.');
  }finally{
   setBusy('');
  }
 };
 const resetSignIn=async()=>{
  try{
   setBusy('reset');
   const sid=getStoredSessionId();
   setStoredSessionId(undefined);
   try{await api.post('/api/auth/session/invalidate',{sessionId:sid},sid?{headers:{'X-Session-Id':sid}}:undefined)}catch{}
   await auth.signOut();
   setSnap(null);
   setError('Sign-in session reset. Select Create secure account to try again.');
  }finally{
   setBusy('');
  }
 };
 const post=async(path:string,body:object={})=>{
  try{
   setBusy(path);
   setError('');
   const sid=getStoredSessionId();
   const payload=sid?{...body,sessionId:sid}:body;
   const request=()=>api.post(path,payload,sid?{headers:{'X-Session-Id':sid}}:undefined);
   let r;
   try{
    r=await request();
   }catch(firstError){
    const status=(firstError as {response?:{status?:number}})?.response?.status;
    if(status===401){
     await handleSignOut('Your session expired for security. Sign in again to continue.');
     return null;
    }
    throw firstError;
   }
   lastActivityRef.current=Date.now();
   await load();
   return r.data;
  }catch(e){
   const status=(e as {response?:{status?:number}})?.response?.status,
         code=(e as {response?:{data?:{error?:string}}})?.response?.data?.error,
         message=(e as {response?:{data?:{error?:string;message?:string}}})?.response?.data?.error||(e as {response?:{data?:{message?:string}}})?.response?.data?.message;
   if(status===401){
    await handleSignOut('Your session expired for security. Sign in again to continue.');
    return null;
   }
   if(status===403&&(code==='recent_activity_required'||code==='recent_authentication_required')){
    setError('For your security, recent session activity is required before this sensitive action. Please sign out and sign in again to proceed.');
    return null;
   }
   const safeMessage=typeof message==='string'&&!message.includes('Internal')&&!message.includes('stack')&&message.length<=200?message:null;
   setError(message==='reconnect_required'||message==='google_not_connected'?'Gmail needs to be reconnected before Trialvisor can sync this inbox.':message?.startsWith('gmail_')?'Gmail could not complete the sync. Your existing findings and protection settings were not changed.':safeMessage||'That action could not be completed safely. Nothing was changed.');
   return null;
  }finally{
   setBusy('');
  }
 };
 const connectGoogle=async()=>{try{setBusy('google');setError('');const r=await api.post('/api/oauth/google/start');window.location.assign(r.data.authorizationUrl)}catch{setError('Google connection could not start safely. Please try again.');setBusy('')}};
 const syncGoogle=async()=>{
  const r=await post('/api/gmail/sync');if(!r)return;
  const confidence=r.confidence||{high:0,medium:0,low:0},summary=confidence.high+' high, '+confidence.medium+' medium, and '+confidence.low+' low confidence';
  if(r.fetchFailures>0)setToast({key:'SYNC_RESULT',text:'Sync needs retry. Gmail returned '+r.fetchFailures+' candidate message'+(r.fetchFailures===1?' that could':'s that could')+' not be retrieved. Trialvisor preserved the prior checkpoint and did not discard those candidates.'});
  else if(r.verifiedCancellations>0)setToast({key:'SYNC_RESULT',text:'Sync complete. Trialvisor independently verified '+r.verifiedCancellations+' Canva cancellation'+(r.verifiedCancellations===1?'':'s')+' from authenticated provider email. Complete message bodies were not retained.'});
  else if(r.created>0){
   const key='FIRST_SUCCESSFUL_INBOX_SYNC',shown=snap?.account.guidanceShown||[];
   if(!shown.includes(key))showGuidance(key,'Sync complete. Trialvisor found subscription activity for you to review.');
   else setToast({key:'SYNC_RESULT',text:'Sync complete. '+r.created+' new review-only finding'+(r.created===1?' was':'s were')+' added ('+summary+'). Nothing was protected automatically.'});
  }else if(r.matched>0)setToast({key:'SYNC_RESULT',text:'Sync complete. '+r.matched+' subscription signal'+(r.matched===1?' was':'s were')+' recognized ('+summary+'), but existing thread/provider safeguards prevented duplicates.'});
  else if(r.scanned>0)setToast({key:'SYNC_RESULT',text:'Sync complete using '+String(r.mode||'bounded discovery').replace(/_/g,' ')+'. '+r.scanned+' candidate message'+(r.scanned===1?' was':'s were')+' processed; none met the subscription-signal rules.'});
  else setToast({key:'SYNC_RESULT',text:'Sync complete. Gmail reported no unprocessed candidate messages. Trialvisor kept all existing findings and protection authority unchanged.'});
 };
 const openCheckout=async(cadence:'monthly'|'annual')=>{const r=await post('/api/billing/checkout',{cadence});if(r?.url)window.location.assign(r.url)};
 const openPortal=async()=>{const r=await post('/api/billing/portal');if(r?.url)window.location.assign(r.url)};
  const protect=async(t:Trial)=>{if(snap?.billing.plan!=='PRO'){setModal(null);setView('billing');setError('Trialvisor Pro is required to protect a new trial. Choose monthly or annual billing to continue.');return}const r=await post('/api/trials/'+t.id+'/protect');setModal(null);if(r)showGuidance('FIRST_PROTECT_AUTHORIZATION',guidanceCopy.FIRST_PROTECT_AUTHORIZATION)};
 const keep=async(t:Trial)=>{await post('/api/trials/'+t.id+'/keep');setModal(null)};
 const cancel=async(t:Trial)=>{if(t.state==='CANCELLATION_NEEDS_USER'){const r=await post('/api/trials/'+t.id+'/provider-step-complete');if(r){setModal(null);if(/\bcanva\b/i.test(t.provider))await syncGoogle()}return}await post('/api/trials/'+t.id+'/cancel-selected');setModal(null)};
 const readNotice=async(id:string)=>{await post('/api/notifications/'+id+'/read')};
 const readAllNotices=async()=>{await post('/api/notifications/read-all')};
 const exportData=async()=>{try{setBusy('export');const sid=getStoredSessionId();const r=await api.get('/api/account/export',sid?{headers:{'X-Session-Id':sid}}:undefined),blob=new Blob([JSON.stringify(r.data,null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='trialvisor-data-export.json';a.click();URL.revokeObjectURL(url)}catch{setError('Your data export could not be prepared. Nothing was changed.')}finally{setBusy('')}};
 const deleteAccount=async()=>{
  try{
    setBusy('delete-account');
    const sid=getStoredSessionId();
    await api.post('/api/account/delete',sid?{confirm:'DELETE',sessionId:sid}:{confirm:'DELETE'},sid?{headers:{'X-Session-Id':sid}}:undefined);
    setStoredSessionId(undefined);
    try{await api.post('/api/auth/session/invalidate',{sessionId:sid},sid?{headers:{'X-Session-Id':sid}}:undefined)}catch{}
   await auth.signOut();
   setSnap(null);
   window.location.assign('./');
  }catch(e){
   const status=(e as {response?:{status?:number}})?.response?.status,
         code=(e as {response?:{data?:{error?:string}}})?.response?.data?.error;
   if(status===401){
    await handleSignOut('Your session expired for security. Sign in again to continue.');
    return;
   }
   if(status===403&&(code==='recent_activity_required'||code==='recent_authentication_required')){
    setError('For your security, recent session activity is required before deleting your account. Please sign out and sign in again to proceed.');
    return;
   }
   const message=(e as {response?:{data?:{error?:string;message?:string}}})?.response?.data?.error||(e as {response?:{data?:{message?:string}}})?.response?.data?.message;
   setError(message||'Account deletion could not be completed safely. Your existing data was not changed.');
  }finally{
   setBusy('');
  }
 };
 const addManual=async(e:React.FormEvent<HTMLFormElement>)=>{e.preventDefault();const f=new FormData(e.currentTarget),r=await post('/api/trials/manual',{provider:String(f.get('provider')||''),plan:String(f.get('plan')||''),price:Number(f.get('price')||0),trialEnd:String(f.get('trialEnd')||'')});if(r)setModal(null)};const manualStart=async()=>{const r=await post('/api/account/onboarding-complete');if(r)setModal({kind:'manual'})};
 if(isPublicInformationPath(window.location.pathname))return <PublicInformationPage path={window.location.pathname} onSignIn={signIn}/>;
if(!auth.isSignedIn()&&!snap)return <main className='landing'><nav className='marketing-nav'><img className='wordmark' src='./resources/trialvisor-wordmark.png' alt='Trialvisor'/><div className='nav-proof'><span>Free trials. Under control.</span><a href='./how-it-works'>How it works</a><button className='ghost' onClick={signIn}>Sign in</button></div></nav><section className='hero'><div className='hero-copy'><div className='eyebrow'>FREE-TRIAL PROTECTION</div><h1>Start the trial.<br/><em>Trialvisor remembers the cancellation.</em></h1><p>Find trial and subscription signals, choose what to protect, and let Trialvisor monitor the safest time to act. Cancellation is never authorized by detection alone.</p><div className='hero-actions'><button onClick={signIn} disabled={!!busy}>{busy==='signin'?'Opening secure sign-in...':'Create secure account'}<ArrowRight size={17}/></button><span>Explicit opt-in. Verified outcomes. No dark patterns.</span></div>{error&&<div className='error'>{error}<button className='link-inline' onClick={resetSignIn}>Reset sign-in</button></div>}</div><div className='hero-product'><div className='mini-brand'><img src='./resources/trialvisor-shield.png' alt=''/><span>Example protection view</span></div><strong>What could charge me next?</strong><article><div><b>Canva Pro</b><span>Charges Sep 12</span></div><div><b>$14.99</b><span>Protected</span></div></article><article className='warning-card'><div><b>Adobe Acrobat</b><span>Charges Sep 8</span></div><div><b>$29.99</b><span>Needs review</span></div></article><div className='preview-foot'><ShieldCheck size={16}/> Safe Cancel Deadline monitored</div></div></section><section className='promise-grid'><article><span>01</span><h3>Discover</h3><p>Trialvisor searches connected inboxes for trial starts, renewal notices, and upcoming charges.</p></article><article><span>02</span><h3>Protect</h3><p>You explicitly authorize protection for a specific trial. Silence only means cancel after that authorization.</p></article><article><span>03</span><h3>Verify</h3><p>Trialvisor checks the provider result and records evidence before calling a cancellation successful.</p></article></section><section className='trust-strip'><span><Check/> Privacy-minimized inbox analysis</span><span><Check/> Revocable connected accounts</span><span><Check/> Auditable cancellation decisions</span></section><div className='landing-links'><a href='./how-it-works'>How Trialvisor works</a><a href='./providers'>Provider support</a><a href='./security'>Security</a><a href='./subprocessors'>Subprocessors</a></div>{toast&&<ToastView toast={toast} close={()=>setToast(null)}/>}</main>;
 if(!snap)return <main className='loading-screen'><section className='loading-card'><img src='./resources/trialvisor-shield.png' alt='Trialvisor'/><div className='eyebrow'>SECURE ACCOUNT</div><h1>{error?'We could not load your protection center.':'Preparing your protection center...'}</h1><p>{error?'Your session remains protected. Retry the account load or sign out and restart the session.':'Loading your tenant-isolated account and protection state.'}</p>{error&&<div className='loading-actions'><button onClick={load}>Try again</button><button className='secondary' onClick={resetSignIn}>Sign out and restart</button></div>}</section></main>;
 const trials=snap.trials||[];
 if(snap&&!snap.account.onboardingComplete){const google=snap.connections.find(x=>x.provider==='Google'&&x.mode==='PRODUCTION');return <main className='onboarding'><header className='onboarding-head'><img className='wordmark' src='./resources/trialvisor-wordmark.png' alt='Trialvisor'/><span>Secure setup</span></header><section className='onboarding-card'><div className='step-count'>INITIAL SETUP</div><img className='onboarding-shield' src='./resources/trialvisor-shield.png' alt=''/><div className='eyebrow'>WELCOME TO TRIALVISOR</div><h1>Connect the accounts you use for trials and subscriptions.</h1><p>Trialvisor uses provider-side searches and retains only subscription-related signals. Nothing is protected until you explicitly choose Protect.</p><div className='trust-row'><span><Check/> Read-only Gmail discovery</span><span><Check/> Explicit Protect authorization</span><span><Check/> Tenant-isolated data</span></div><div className='connect-stack'>{google?<><div className='connected-callout'><CheckCircle2/><div><b>Google connected</b><span>{google.providerAccountIdentifier||'Ready for privacy-minimized discovery'}</span></div></div><button onClick={syncGoogle} disabled={!!busy}><RefreshCw size={17}/>Sync Gmail</button><button className='secondary' onClick={()=>post('/api/account/onboarding-complete')} disabled={!!busy}>Continue to dashboard</button></>:<button onClick={connectGoogle} disabled={!!busy}><Mail size={17}/>Connect Google</button>}<button className='secondary' onClick={manualStart}><Plus size={17}/>Add a trial manually instead</button></div>{error&&<div className='error'>{error}</div>}<p className='fineprint'>You can reconnect or revoke a connected inbox at any time from Connected accounts.</p></section>{toast&&<ToastView toast={toast} close={()=>setToast(null)}/>}<ModalView modal={modal} close={()=>setModal(null)} addManual={addManual} staySignedIn={staySignedIn} onSignOut={()=>handleSignOut()}/></main>}
 const protectedTrials=trials.filter(t=>['AUTO_CANCEL_ENABLED','DECISION_PENDING'].includes(t.state));
 const reviewTrials=trials.filter(t=>t.state==='REVIEW_REQUIRED');
 const actionTrials=trials.filter(t=>['CANCELLATION_NEEDS_USER','CANCELLATION_FAILED'].includes(t.state));
 const soonTrials=trials.filter(t=>!['CANCELED_CONFIRMED','KEEP_REQUESTED'].includes(t.state)&&t.enrollmentStatus==='ACTIVE'&&t.exposureStatus==='CONFIRMED'&&daysLeft(t.trialEnd)<=7);
 const exposure7=snap.exposure?.confirmed7||0;
 const exposure30=snap.exposure?.confirmed30||0;
 const ordered=[...trials].sort((a,b)=>new Date(a.safeDeadline).getTime()-new Date(b.safeDeadline).getTime());
 const google=snap.connections.find(x=>x.provider==='Google'&&x.mode==='PRODUCTION');
 return <div className='shell'><aside className={mobileNav?'mobile-open':''}><div className='side-brand'><img className='wordmark' src='./resources/trialvisor-wordmark.png' alt='Trialvisor'/><button className='icon-button close-nav' onClick={()=>setMobileNav(false)} aria-label='Close navigation'><X/></button></div><nav className='app-nav' aria-label='Primary'><NavButton icon={<ShieldCheck/>} active={view==='overview'} onClick={()=>{setView('overview');setMobileNav(false)}}>Overview</NavButton><NavButton icon={<Inbox/>} active={view==='protection'} onClick={()=>{setView('protection');setMobileNav(false)}}>Protection</NavButton><NavButton icon={<Link2/>} active={view==='accounts'} onClick={()=>{setView('accounts');setMobileNav(false)}}>Connected accounts</NavButton><NavButton icon={<History/>} active={view==='activity'} onClick={()=>{setView('activity');setMobileNav(false)}}>Activity</NavButton><NavButton icon={<AlertTriangle/>} active={view==='notifications'} onClick={()=>{setView('notifications');setMobileNav(false)}}>Notifications{snap.notifications?.some(n=>!n.readAt)?` (${snap.notifications.filter(n=>!n.readAt).length})`:''}</NavButton><NavButton icon={<CircleDollarSign/>} active={view==='settings'} onClick={()=>{setView('settings');setMobileNav(false)}}>Settings</NavButton></nav><div className='aside-help'><button onClick={()=>setView('billing')}>Plan & billing</button><a href='./how-it-works'>How Trialvisor works</a><a href='./security'>Security</a></div><div className='aside-foot'><div className='user-block'><span>{snap.user.name||'Trialvisor member'}</span><small>{snap.user.email}</small></div><button className='link' onClick={()=>handleSignOut()}><LogOut size={15}/>Sign out</button></div></aside><div className='workspace'><header className='mobile-header'><button className='icon-button' onClick={()=>setMobileNav(true)} aria-label='Open navigation'><Menu/></button><img src='./resources/trialvisor-shield.png' alt='Trialvisor'/><strong>Trialvisor</strong></header><main className='dashboard'>
 {view==='overview'&&<><header className='page-head'><div><div className='eyebrow'>YOUR PROTECTION CENTER</div><h2>What could charge me next?</h2><p>Prioritize the items that can still become unwanted charges.</p></div><button className='secondary compact' onClick={()=>setModal({kind:'manual'})}><Plus size={16}/>Add trial</button></header>{error&&<div className='error'>{error}</div>}
 <section className='health'><div><span>PROTECTION HEALTH</span><b>{trials.length} subscriptions detected</b><small>{protectedTrials.length} protected · {reviewTrials.length} need review · {soonTrials.length} may charge within 7 days</small></div><strong className={actionTrials.length?'urgent-pill':'good-pill'}>{actionTrials.length?`${actionTrials.length} action required`:'Protection stable'}</strong></section>
 {actionTrials.length>0&&<section className='priority-section'><div className='section-label urgent'><AlertTriangle/>ACTION REQUIRED</div>{actionTrials.map(t=><TrialCard key={t.id} t={t} primaryLabel='Review required step' onPrimary={()=>setModal({kind:'decision',trial:t})}/>)}</section>}
 <section className='metrics'><article><CircleDollarSign/><div><b>{money(snap.saved||0)}</b><span>confirmed unwanted renewals prevented</span></div></article><article><CalendarClock/><div><b>{money(exposure7)}</b><span>confirmed exposure in next 7 days</span></div></article><article><ShieldCheck/><div><b>{money(exposure30)}</b><span>confirmed exposure in next 30 days</span></div></article></section>
 <section className='panel protection-inbox'><div className='panel-head'><div><div className='section-kicker'>PROTECTION INBOX</div><h3>Review, protect, and resolve</h3><p>Detection is evidence to review, never cancellation authority.</p></div><button className='secondary' onClick={()=>setView('accounts')}><Inbox size={16}/>Connected accounts</button></div>{!ordered.length?<div className='empty'><Mail/><h4>No subscription findings yet</h4><p>Connect Gmail or add a trial manually. Trialvisor will keep detection separate from authorization.</p><button onClick={()=>setView('accounts')}>Connect an inbox</button></div>:<div className='trial-list'>{ordered.map(t=><TrialCard key={t.id} t={t} primaryLabel={t.state==='REVIEW_REQUIRED'&&t.enrollmentStatus!=='POSSIBLE'?'Protect':t.state==='AUTO_CANCEL_ENABLED'||t.state==='DECISION_PENDING'?'Review decision':undefined} onPrimary={()=>t.state==='REVIEW_REQUIRED'?setModal({kind:'protect',trial:t}):setModal({kind:'decision',trial:t})}/>)}</div>}</section></>}
 {view==='protection'&&<section><header className='page-head'><div><div className='eyebrow'>PROTECTION</div><h2>Protected trials and review queue</h2><p>Every detected item remains separate from cancellation authority until you choose Protect.</p></div><button className='secondary compact' onClick={()=>setModal({kind:'manual'})}><Plus size={16}/>Add trial</button></header><div className='trial-list'>{ordered.length?ordered.map(t=><TrialCard key={t.id} t={t} primaryLabel={t.state==='REVIEW_REQUIRED'&&t.enrollmentStatus!=='POSSIBLE'?'Protect':t.state==='AUTO_CANCEL_ENABLED'||t.state==='DECISION_PENDING'?'Review decision':undefined} onPrimary={()=>t.state==='REVIEW_REQUIRED'?setModal({kind:'protect',trial:t}):setModal({kind:'decision',trial:t})}/>):<div className='empty'><ShieldCheck/><h4>No protection items yet</h4><p>Connect an inbox or add a trial manually to begin review.</p></div>}</div></section>}
{view==='accounts'&&<section><header className='page-head'><div><div className='eyebrow'>CONNECTED ACCOUNTS</div><h2>Subscription discovery sources</h2><p>Your Trialvisor login is separate from the inboxes you authorize for discovery.</p></div></header>{error&&<div className='error' role='alert'>{error}</div>}<div className='account-grid'>{['Google','Microsoft'].map(provider=>{const c=snap.connections.find(x=>x.provider===provider&&(provider!=='Google'||x.mode==='PRODUCTION'));const configured=provider==='Google'?snap.config.google:snap.config.microsoft;return <article className='account-card' key={provider}><div className='account-title'><div className={'provider '+provider.toLowerCase()}>{provider[0]}</div><div><h3>{provider}</h3><span>{c?.providerAccountIdentifier||'Not connected'}</span></div><StatusBadge state={c?.status||'DISCONNECTED'}/></div><dl><div><dt>Connection</dt><dd>{c?.status||'Not connected'}</dd></div><div><dt>Last sync</dt><dd>{c?.lastSync?dateTime(c.lastSync):'Never'}</dd></div><div><dt>Discovery</dt><dd>{provider==='Google'&&c?(snap.gmailDiscovery?.verified?'Real mailbox finding verified':'Connected - real finding still pending validation'):'No validated findings yet'}</dd></div></dl><div className='account-actions'>{provider==='Google'&&configured?(c?<><button onClick={syncGoogle} disabled={!!busy}><RefreshCw size={16}/>{busy==='/api/gmail/sync'?'Syncing…':'Sync'}</button><button className='secondary' onClick={connectGoogle} disabled={!!busy}>Reconnect</button><button className='text-danger' onClick={()=>post('/api/oauth/google/disconnect')} disabled={!!busy}>Disconnect</button></>:<button onClick={connectGoogle} disabled={!!busy}>Connect Google</button>):<button className='secondary' disabled>{configured?'Connection coming next':'Production OAuth not configured'}</button>}</div></article>})}</div>{google&&<div className='validation-note'><Eye/><div><b>Real Gmail discovery validation</b><span>{snap.gmailDiscovery?.verified?'Verified with at least one persisted mailbox finding.':`Still open. ${snap.gmailDiscovery?.processedReferences||0} message references processed and ${snap.gmailDiscovery?.matchedReferences||0} matched so far.`}</span>{snap.gmailDiscovery?.lastResult&&<small className='validation-template'>Last sync: {snap.gmailDiscovery.lastResult.mode.replace(/_/g,' ')} · {snap.gmailDiscovery.lastResult.scanned} scanned · {snap.gmailDiscovery.lastResult.matched} matched · {snap.gmailDiscovery.lastResult.created} new · {snap.gmailDiscovery.lastResult.duplicates} duplicates · {snap.gmailDiscovery.lastResult.fetchFailures} retrieval failures.</small>}{!snap.gmailDiscovery?.verified&&<small className='validation-template'>Controlled check: from another address, email the connected Gmail account with subject “Your free trial has started” and body “Your trial ends September 10, 2026. You will be charged $14.99/month after your trial.” Then select Sync.</small>}</div></div>}</section>}
 {view==='activity'&&<ActivityCenter activity={snap.activity||[]} onTrial={()=>setView('protection')}/>}
 {view==='notifications'&&<NotificationCenter notices={snap.notifications||[]} onRead={readNotice} onReadAll={readAllNotices} onNavigate={v=>setView(v as typeof view)}/>}
 {view==='settings'&&<DataControls connections={snap.connections.filter(c=>c.mode==='PRODUCTION')} onDisconnect={()=>post('/api/oauth/google/disconnect')} onExport={exportData} onDelete={deleteAccount}/>}
 {view==='billing'&&<section><header className='page-head'><div><div className='eyebrow'>PLAN & BILLING</div><h2>Protection that stays easy to cancel</h2><p>Stripe-hosted checkout and account management with server-verified access.</p></div></header><div className='billing-card'><div><span className='plan-pill'>CURRENT PLAN</span><h3>Trialvisor {snap.billing.plan==='PRO'?'Pro':'Free'}</h3><p>{snap.billing.plan==='PRO'?`Paid protection is ${label(snap.billing.status).toLowerCase()}${snap.billing.cancelAtPeriodEnd?' and scheduled to end':''}.`:'Your account is on the Free plan. Paid access activates only after a signed Stripe subscription event.'}</p>{snap.billing.currentPeriodEnd&&<small>Current period ends {day(snap.billing.currentPeriodEnd)}</small>}</div>{snap.billing.plan==='PRO'?<button onClick={openPortal} disabled={!!busy}>Manage billing</button>:<div className='billing-actions'><button onClick={()=>openCheckout('monthly')} disabled={!snap.config.stripe||!!busy}>Choose monthly</button><button className='secondary' onClick={()=>openCheckout('annual')} disabled={!snap.config.stripe||!!busy}>Choose annual</button>{snap.billing.hasCustomer&&<button className='secondary' onClick={openPortal} disabled={!!busy}>Manage billing</button>}<small>{snap.config.stripe?'Exact prices are shown in secure Stripe Checkout.':'Paid plans activate after Stripe test configuration is complete.'}</small></div>}</div><div className='billing-trust'><ShieldCheck/><div><b>Webhook-verified access</b><span>A browser redirect never grants Pro access. Trialvisor changes entitlements only after validating Stripe’s signed subscription event.</span></div></div></section>}
 <footer><img src='./resources/trialvisor-shield.png' alt=''/><span>Critical cancellation execution runs server-side. Frontend availability never controls scheduled protection.</span></footer></main></div>{toast&&<ToastView toast={toast} close={()=>setToast(null)}/>}<ModalView modal={modal} close={()=>setModal(null)} protect={protect} keep={keep} cancel={cancel} addManual={addManual} staySignedIn={staySignedIn} onSignOut={()=>handleSignOut()}/></div>
}
function NavButton({icon,active,onClick,children}:{icon:React.ReactNode;active:boolean;onClick:()=>void;children:React.ReactNode}){return <button className={'nav '+(active?'active':'')} onClick={onClick}>{icon}<span>{children}</span><ChevronRight className='nav-arrow'/></button>}
function StatusBadge({state}:{state:string}){return <span className={'status status-'+state.toLowerCase()}>{label(state)}</span>}
function TrialCard({t,primaryLabel,onPrimary}:{t:Trial;primaryLabel?:string;onPrimary?:()=>void}){const isAssist=t.state==='CANCELLATION_NEEDS_USER',isCanceled=t.state==='CANCELED_CONFIRMED';return <article className={'trial '+(isAssist?'trial-assist ':'')+(isCanceled?'trial-canceled':'')}><div className='trial-top'><div className='provider-icon'>{t.provider[0]}</div><div className='trial-name'><h4>{t.provider}<span>{t.plan}</span></h4><div className='chips'><StatusBadge state={t.state}/><i>{t.sourceRef?'Inbox detected':'Manual'}</i><i>{t.confidenceBand||Math.round(t.confidence*100)+'%'} confidence</i></div></div><div className='charge'><b>{money(t.price)}</b><span>/ month</span></div></div><div className='dates'><div><span>TRIAL ENDS</span><b>{day(t.providerTrialEndDate||t.trialEnd)}</b></div><div><span>SAFE CANCEL DEADLINE</span><b>{dateTime(t.safeDeadline)}</b></div><div><span>PLANNED ACTION</span><b>{dateTime(t.plannedExecution)}</b></div><div><span>CANCELLATION SUPPORT</span><b>{supportLabel(t)}</b></div></div>{isAssist&&<div className='assist'><AlertTriangle size={18}/><div><b>Action required</b><span>{t.nextAction||'The provider requires your participation before Trialvisor can continue.'}</span></div></div>}{t.evidence&&<div className='evidence'><CheckCircle2 size={18}/><div><b>Verified cancellation</b><span>{t.evidence}</span></div></div>}<div className='actions'>{primaryLabel&&onPrimary&&<button onClick={onPrimary}>{primaryLabel}<ChevronRight size={16}/></button>}{isCanceled&&<span className='success'>Cancellation independently verified</span>}{t.state==='KEEP_REQUESTED'&&<span className='kept'>Kept - scheduled cancellation revoked and audited.</span>}</div><details className='trial-activity'><summary>Activity timeline</summary><TrialActivity activity={t.activity||[]}/></details></article>}
function ToastView({toast,close}:{toast:Toast;close:()=>void}){if(!toast)return null;return <div className='toast' role='status' aria-live='polite'><img src='./resources/trialvisor-shield.png' alt=''/><div><b>Trialvisor</b><span>{toast.text}</span></div><button onClick={close} aria-label='Dismiss guidance'><X/></button></div>}
function ModalView({modal,close,protect,keep,cancel,addManual,staySignedIn,onSignOut}:{modal:Modal;close:()=>void;protect?:(t:Trial)=>void;keep?:(t:Trial)=>void;cancel?:(t:Trial)=>void;addManual?:(e:React.FormEvent<HTMLFormElement>)=>void;staySignedIn?:()=>void;onSignOut?:()=>void}){const dialogRef=useRef<HTMLElement|null>(null),priorFocus=useRef<HTMLElement|null>(null);useEffect(()=>{if(!modal)return;priorFocus.current=document.activeElement as HTMLElement;const el=dialogRef.current;el?.focus();const onKey=(e:KeyboardEvent)=>{if(e.key==='Escape'){if(modal.kind==='session_warning')staySignedIn?.();else close();}if(e.key==='Tab'&&el){const focusable=Array.from(el.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled]),[href],[tabindex]:not([tabindex="-1"])'));if(!focusable.length)return;const first=focusable[0],last=focusable[focusable.length-1];if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus()}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus()}}};document.addEventListener('keydown',onKey);return()=>{document.removeEventListener('keydown',onKey);priorFocus.current?.focus()}},[modal,close,staySignedIn]);if(!modal)return null;if(modal.kind==='session_warning')return <div className='modal-backdrop' role='presentation'><section ref={dialogRef} tabIndex={-1} className='modal' role='dialog' aria-modal='true' aria-labelledby='session-warning-title'><div className='modal-brand'><img src='./resources/trialvisor-shield.png' alt=''/><span>SECURITY NOTICE</span></div><h2 id='session-warning-title'>Session expiring soon</h2><p>Your session will expire soon due to inactivity</p><div className='decision-actions'><button className='wide' onClick={staySignedIn}>Stay signed in</button><button className='modal-secondary' onClick={onSignOut}>Sign out</button></div></section></div>;const t=modal.trial;if(modal.kind==='manual')return <div className='modal-backdrop' role='presentation' onMouseDown={e=>{if(e.target===e.currentTarget)close()}}><section ref={dialogRef} tabIndex={-1} className='modal' role='dialog' aria-modal='true' aria-labelledby='manual-title'><button className='modal-close' onClick={close} aria-label='Close'><X/></button><div className='modal-brand'><img src='./resources/trialvisor-shield.png' alt=''/><span>MANUAL TRIAL</span></div><h2 id='manual-title'>Add a trial you already know about</h2><p>Trialvisor will calculate a conservative Safe Cancel Deadline and keep protection disabled until you review it.</p><form onSubmit={addManual}><label>Provider<input name='provider' required placeholder='Canva'/></label><label>Plan<input name='plan' placeholder='Pro trial'/></label><div className='form-row'><label>Monthly price<input name='price' type='number' min='0' step='0.01' placeholder='14.99'/></label><label>Trial end<input name='trialEnd' type='date' required min={new Date(Date.now()+86400000).toISOString().split('T')[0]}/></label></div><button type='submit'>Add for review</button></form></section></div>;if(!t)return null;if(modal.kind==='protect')return <div className='modal-backdrop' role='presentation' onMouseDown={e=>{if(e.target===e.currentTarget)close()}}><section ref={dialogRef} tabIndex={-1} className='modal' role='dialog' aria-modal='true' aria-labelledby='protect-title'><button className='modal-close' onClick={close} aria-label='Close'><X/></button><div className='modal-brand'><img src='./resources/trialvisor-shield.png' alt=''/><span>PROTECT THIS TRIAL</span></div><h2 id='protect-title'>{t.provider} {t.plan}</h2><div className='protect-price'><b>{money(t.price)}/month</b><span>{money(annual(t.price))}/year if kept for 12 months</span></div><div className='modal-facts'><div><span>Trial ends</span><b>{day(t.providerTrialEndDate||t.trialEnd)}</b></div><div><span>Safe Cancel Deadline</span><b>{dateTime(t.safeDeadline)}</b></div><div><span>Planned action</span><b>{dateTime(t.plannedExecution)}</b></div><div><span>Cancellation support</span><b>{supportLabel(t)}</b></div></div><div className='authorization-copy'><ShieldCheck/><p>{t.support==='GUIDED'?'Protect records your authorization and schedules the deadline. Canva still requires you to complete its official cancellation steps; Trialvisor will not call the result verified without authenticated provider evidence.':t.support==='NOT_SUPPORTED'?'Protect records monitoring and your intent, but no reliable Trialvisor cancellation workflow exists for this provider. Action Required will remain visible; no success will be claimed without evidence.':'If you do not choose to keep this subscription before the scheduled cancellation, Trialvisor will proceed only within the cancellation support shown here.'}</p></div><button className='wide' onClick={()=>protect?.(t)}>Protect this trial</button><button className='modal-secondary' onClick={close}>Not now</button></section></div>;return <div className='modal-backdrop' role='presentation' onMouseDown={e=>{if(e.target===e.currentTarget)close()}}><section ref={dialogRef} tabIndex={-1} className='modal' role='dialog' aria-modal='true' aria-labelledby='decision-title'><button className='modal-close' onClick={close} aria-label='Close'><X/></button><div className='modal-brand'><img src='./resources/trialvisor-shield.png' alt=''/><span>{t.state==='CANCELLATION_NEEDS_USER'?'ACTION REQUIRED':'PROTECTION DECISION'}</span></div><h2 id='decision-title'>{t.provider} is approaching its billing date.</h2><div className='decision-cost'><div><span>Next charge</span><b>{money(t.price)}/month</b></div><div><span>Annualized</span><b>{money(annual(t.price))}/year if continued monthly</b></div><div><span>Safe Cancel Deadline</span><b>{dateTime(t.safeDeadline)}</b></div></div>{t.state==='CANCELLATION_NEEDS_USER'?<><div className='assist large'><AlertTriangle/><div><b>Trialvisor needs your participation</b><span>{t.nextAction||'Complete the provider-required identity step before the deadline.'}</span></div></div><div className='decision-actions'>{t.cancellationUrl&&<a className='secondary' href={t.cancellationUrl} target='_blank' rel='noreferrer'>Open official {t.provider} guide</a>}<button onClick={()=>cancel?.(t)}>I completed the provider steps</button></div></>:<div className='neutral-note'>Your existing protection authorization remains active until you choose Keep or revoke it.</div>}<div className='decision-actions'><button className='keep-button' onClick={()=>keep?.(t)}>Keep service</button><button className='cancel-button' onClick={()=>cancel?.(t)} disabled={t.state==='CANCELLATION_NEEDS_USER'}>Cancel as planned</button></div></section></div>}
export default App;
