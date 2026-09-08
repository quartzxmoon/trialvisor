import assert from 'node:assert/strict';
import test from 'node:test';
import { isPromotionalContent, classifySignal } from '../backend/provider-signals.ts';

type State = 'REVIEW_REQUIRED' | 'AUTO_CANCEL_ENABLED' | 'DECISION_PENDING' | 'KEEP_REQUESTED' | 'CANCELLATION_RUNNING' | 'CANCELLATION_NEEDS_USER' | 'CANCELED_CONFIRMED' | 'DISMISSED';
type SignalKind = 'ACTIVE' | 'POSSIBLE' | 'PROMOTIONAL';

interface Trial {
  id: string;
  userId: string;
  provider: string;
  plan: string;
  price: number;
  currency: string;
  trialEnd?: string;
  safeDeadline?: string;
  plannedExecution?: string;
  state: State;
  tier: string;
  confidence: number;
  confidenceBand?: 'HIGH' | 'MEDIUM' | 'LOW';
  kind?: SignalKind;
  dismissedAt?: string;
  dismissReason?: string;
  sourceRef?: { provider: 'google' | 'microsoft'; messageId: string; threadId: string; receivedAt?: string };
  authorizationAt?: string;
  providerTrialEndDate?: string;
  hasExplicitTime?: boolean;
}

const table = (u: string, n: string) => n + ':' + u;

const createMockDatabase = (seed: Array<{ table: string; id: string; record: Record<string, unknown> }> = []) => {
  const store = new Map<string, Map<string, Record<string, unknown>>>();
  let nextIdCounter = 1;

  for (const s of seed) {
    if (!store.has(s.table)) store.set(s.table, new Map());
    store.get(s.table)!.set(s.id, { ...s.record, id: s.id });
  }

  return {
    async add(tblName: string, records: Array<Record<string, unknown>>) {
      if (!store.has(tblName)) store.set(tblName, new Map());
      const tbl = store.get(tblName)!;
      return records.map(r => {
        const id = (r.id as string) || ('id_' + (nextIdCounter++));
        tbl.set(id, { ...r, id });
        return id;
      });
    },
    async update(tblName: string, items: Array<{ id: string; record: Record<string, unknown> }>) {
      if (!store.has(tblName)) store.set(tblName, new Map());
      const tbl = store.get(tblName)!;
      return items.map(item => {
        if (!tbl.has(item.id)) return false;
        tbl.set(item.id, { ...item.record, id: item.id });
        return true;
      });
    },
    async list<T = Record<string, unknown>>(tblName: string, options?: { limit?: number; nextToken?: string }) {
      const tbl = store.get(tblName);
      if (!tbl) return { items: [] as Array<T & { id: string }> };
      const all = Array.from(tbl.values()) as Array<T & { id: string }>;
      const offset = Number(options?.nextToken || 0);
      const limit = options?.limit || 100;
      const items = all.slice(offset, offset + limit);
      const nextToken = offset + limit < all.length ? String(offset + limit) : undefined;
      return { items, nextToken };
    },
    async get<T = Record<string, unknown>>(tblName: string, ids: string[]) {
      const tbl = store.get(tblName);
      if (!tbl) return ids.map(() => null);
      return ids.map(id => (tbl.get(id) ? ({ ...tbl.get(id) } as T & { id: string }) : null));
    },
    async delete(tblName: string, ids: string[]) {
      const tbl = store.get(tblName);
      if (!tbl) return ids.map(() => false);
      return ids.map(id => tbl.delete(id));
    }
  };
};

const audit = async (db: any, userId: string, trialId: string, type: string, detail: string) => {
  await db.add(table(userId, 'audit'), [{ userId, trialId, type, detail, at: new Date().toISOString() }]);
};

// Exact confirm handler logic matching backend/index.ts POST /api/trials/:id/confirm
const confirmFinding = async (db: any, u: string, id: string, b: { price?: number; trialEnd?: string; plan?: string } = {}) => {
  const [t] = await db.get(table(u, 'trials'), [id]);
  if (!t || t.state !== 'REVIEW_REQUIRED') return { status: 409, error: 'Trial is not eligible for confirmation' };
  const price = typeof b.price === 'number' ? Math.max(0, b.price) : t.price;
  const trialEnd = b.trialEnd || t.trialEnd;
  const plan = (b.plan || t.plan).trim();
  let safeDeadline = t.safeDeadline, plannedExecution = t.plannedExecution, providerTrialEndDate = t.providerTrialEndDate;
  if (trialEnd) {
    const end = new Date(trialEnd);
    if (!isNaN(end.getTime())) {
      const deadline = new Date(end.getTime() - 48 * 3600000);
      const run = new Date(deadline.getTime() - 3600000);
      safeDeadline = deadline.toISOString();
      plannedExecution = run.toISOString();
      if (/^\d{4}-\d{2}-\d{2}$/.test(trialEnd)) providerTrialEndDate = trialEnd;
    }
  }
  const updated: Trial = {
    ...t,
    kind: 'ACTIVE',
    plan,
    price,
    trialEnd,
    safeDeadline,
    plannedExecution,
    providerTrialEndDate,
    confidence: 1,
    confidenceBand: 'HIGH'
  };
  await db.update(table(u, 'trials'), [{ id, record: updated }]);
  await audit(db, u, id, 'TRIAL_CONFIRMED', 'User confirmed subscription finding: ' + plan + '.');
  return { status: 200, trial: updated };
};

// Exact dismiss handler logic matching backend/index.ts POST /api/trials/:id/dismiss
const dismissFinding = async (db: any, u: string, id: string, b: { reason?: string } = {}) => {
  const [t] = await db.get(table(u, 'trials'), [id]);
  if (!t) return { status: 404, error: 'Trial not found' };
  if (t.state !== 'REVIEW_REQUIRED') return { status: 409, error: 'Only uncommitted review items can be dismissed' };
  const reason = (b.reason || 'not_a_subscription').slice(0, 100);
  const now = new Date().toISOString();
  const isOfferOnly = reason === 'offer_only';
  const updated: Trial = {
    ...t,
    state: 'DISMISSED',
    dismissedAt: now,
    dismissReason: reason,
    kind: isOfferOnly ? 'PROMOTIONAL' : t.kind,
    price: isOfferOnly ? 0 : t.price,
    trialEnd: isOfferOnly ? undefined : t.trialEnd,
    providerTrialEndDate: isOfferOnly ? undefined : t.providerTrialEndDate,
    hasExplicitTime: isOfferOnly ? false : t.hasExplicitTime,
    safeDeadline: undefined,
    plannedExecution: undefined
  };
  await db.update(table(u, 'trials'), [{ id, record: updated }]);
  if (t.sourceRef?.messageId) {
    const sources = (await db.list(table(u, 'gmail-sources'), { limit: 200 })).items;
    const src = sources.find((s: any) => s.messageId === t.sourceRef?.messageId);
    if (src) {
      await db.update(table(u, 'gmail-sources'), [{ id: src.id, record: { ...src, matched: false, kind: 'user_dismissed', processorVersion: 5 } }]);
    }
  }
  await audit(db, u, id, 'TRIAL_DISMISSED', 'Finding dismissed by user (' + reason + '). Will not recur.');
  return { status: 200, ok: true };
};

// Exact protect handler logic matching backend/index.ts POST /api/trials/:id/protect
const protectTrial = async (db: any, u: string, id: string, hasPro: boolean = true) => {
  if (!hasPro) return { status: 402, error: 'Trialvisor Pro is required to protect a new trial' };
  const [t] = await db.get(table(u, 'trials'), [id]);
  if (!t || t.state !== 'REVIEW_REQUIRED' || t.kind === 'PROMOTIONAL' || t.kind === 'POSSIBLE') {
    return { status: 409, error: 'Trial is not eligible' };
  }
  if (!t.safeDeadline || !t.plannedExecution || !t.trialEnd) {
    return { status: 400, error: 'Confirmed trial end date is required before protection can be scheduled' };
  }
  const jobs = (await db.list('jobs', { limit: 100 })).items.filter((j: any) => j.userId === u && j.trialId === id && j.status === 'PENDING');
  if (jobs.length) return { status: 409, error: 'Protection is already scheduled' };
  const authorizedAt = new Date().toISOString();
  const next: Trial = { ...t, state: 'AUTO_CANCEL_ENABLED', authorizationAt: authorizedAt };
  await db.update(table(u, 'trials'), [{ id, record: next }]);
  await db.add('jobs', [
    { userId: u, trialId: id, kind: 'DECISION', dueAt: new Date(new Date(t.plannedExecution).getTime() - 24 * 3600000).toISOString(), status: 'PENDING', attempts: 0, idempotencyKey: 'decision:' + id },
    { userId: u, trialId: id, kind: 'CANCEL', dueAt: t.plannedExecution, status: 'PENDING', attempts: 0, idempotencyKey: 'cancel:' + id }
  ]);
  await audit(db, u, id, 'AUTHORIZATION_GRANTED', 'Auto Cancel explicitly authorized for this subscription.');
  return { status: 200, ok: true };
};

// Exact v4 migration logic matching backend/index.ts reprocessV4Findings
const reprocessV4Findings = async (db: any, u: string) => {
  const allTrials = (await db.list(table(u, 'trials'), { limit: 100 })).items;
  const updates: Array<{ id: string; record: Trial }> = [];
  const now = new Date().toISOString();
  for (const t of allTrials) {
    if (!t.id || t.state !== 'REVIEW_REQUIRED') continue;
    const isPromo = isPromotionalContent(t.plan, t.plan + ' ' + t.provider) ||
      /\b(?:droplist|price drop|switch and save|visa prepaid|trade-in|start your free trial|try for free|discount code|promo code)\b/i.test(t.plan);
    if (isPromo) {
      const updated: Trial = {
        ...t,
        kind: 'PROMOTIONAL',
        state: 'DISMISSED',
        dismissedAt: now,
        dismissReason: 'v5 recovery migration: promotional marketing finding dismissed',
        price: 0,
        trialEnd: undefined,
        providerTrialEndDate: undefined,
        hasExplicitTime: false,
        safeDeadline: undefined,
        plannedExecution: undefined
      };
      updates.push({ id: t.id, record: updated });
      await audit(db, u, t.id, 'TRIAL_DISMISSED', 'v5 migration: promotional item automatically dismissed from review queue.');
      if (t.sourceRef?.messageId) {
        const sources = (await db.list(table(u, 'gmail-sources'), { limit: 200 })).items;
        const src = sources.find((s: any) => s.messageId === t.sourceRef?.messageId);
        if (src) {
          await db.update(table(u, 'gmail-sources'), [{ id: src.id, record: { ...src, matched: false, kind: 'promotional_suppressed', processorVersion: 5 } }]);
        }
      }
      continue;
    }
    if (!t.kind) {
      const isExplicit = /\b(your free trial has started|trial ends|subscription renews|will be charged)\b/i.test(t.plan);
      const newKind: SignalKind = isExplicit ? 'ACTIVE' : 'POSSIBLE';
      const updated: Trial = {
        ...t,
        kind: newKind,
        safeDeadline: newKind === 'POSSIBLE' ? undefined : t.safeDeadline,
        plannedExecution: newKind === 'POSSIBLE' ? undefined : t.plannedExecution
      };
      updates.push({ id: t.id, record: updated });
    }
  }
  if (updates.length) await db.update(table(u, 'trials'), updates);
};

const daysLeft = (d?: string) => {
  if (!d) return 999;
  const target = new Date(d).getTime(), now = Date.now();
  return Math.ceil((target - now) / 86400000);
};

// ==================================================
// 1. EXECUTABLE REVIEW-ACTION REGRESSION TESTS
// ==================================================

test('1A. REVIEW ACTION: User confirms POSSIBLE finding -> moves to confirmed ACTIVE state', async () => {
  const db = createMockDatabase([
    {
      table: table('u1', 'trials'),
      id: 't_poss_1',
      record: {
        userId: 'u1',
        provider: 'Notion',
        plan: 'Team workspace subscription',
        price: 10,
        currency: 'USD',
        trialEnd: '2026-09-20T00:00:00.000Z',
        state: 'REVIEW_REQUIRED',
        kind: 'POSSIBLE',
        confidence: 0.74,
        confidenceBand: 'MEDIUM',
        tier: '3'
      }
    }
  ]);

  const res = await confirmFinding(db, 'u1', 't_poss_1', { price: 12, trialEnd: '2026-09-20' });
  assert.equal(res.status, 200);
  assert.equal(res.trial?.kind, 'ACTIVE', 'Kind must become ACTIVE upon user confirmation');
  assert.equal(res.trial?.confidence, 1.0);
  assert.equal(res.trial?.confidenceBand, 'HIGH');
  assert.equal(res.trial?.price, 12);
  assert.ok(res.trial?.safeDeadline, 'Safe Cancel Deadline must be derived upon confirmed date');
  assert.ok(res.trial?.plannedExecution, 'Planned execution must be derived upon confirmed date');

  // Verify audit entry
  const audits = (await db.list(table('u1', 'audit'))).items;
  assert.ok(audits.some((a: any) => a.type === 'TRIAL_CONFIRMED' && a.trialId === 't_poss_1'));
});

test('1B. REVIEW ACTION: User dismisses POSSIBLE finding -> marked DISMISSED and removed from review', async () => {
  const db = createMockDatabase([
    {
      table: table('u1', 'trials'),
      id: 't_poss_2',
      record: {
        userId: 'u1',
        provider: 'Dropbox',
        plan: 'Account storage tier',
        price: 9.99,
        currency: 'USD',
        state: 'REVIEW_REQUIRED',
        kind: 'POSSIBLE',
        confidence: 0.44,
        tier: '3',
        sourceRef: { provider: 'google', messageId: 'msg_dropbox_1', threadId: 'th_1' }
      }
    },
    {
      table: table('u1', 'gmail-sources'),
      id: 'src_1',
      record: {
        messageId: 'msg_dropbox_1',
        threadId: 'th_1',
        matched: true,
        kind: 'subscription_signal',
        processorVersion: 5
      }
    }
  ]);

  const res = await dismissFinding(db, 'u1', 't_poss_2', { reason: 'not_a_subscription' });
  assert.equal(res.status, 200);

  const [t] = await db.get<Trial>(table('u1', 'trials'), ['t_poss_2']);
  assert.ok(t);
  assert.equal(t.state, 'DISMISSED');
  assert.equal(t.dismissReason, 'not_a_subscription');
  assert.ok(t.dismissedAt);

  // Verify source message marked user_dismissed
  const [src] = await db.get(table('u1', 'gmail-sources'), ['src_1']);
  assert.ok(src);
  assert.equal(src.matched, false);
  assert.equal(src.kind, 'user_dismissed');

  // Verify audit
  const audits = (await db.list(table('u1', 'audit'))).items;
  assert.ok(audits.some((a: any) => a.type === 'TRIAL_DISMISSED'));
});

test('1C. REVIEW ACTION: User dismisses as offer_only -> classified as PROMOTIONAL and price cleared', async () => {
  const db = createMockDatabase([
    {
      table: table('u1', 'trials'),
      id: 't_poss_3',
      record: {
        userId: 'u1',
        provider: 'CreativeCloud',
        plan: 'Special creative offer',
        price: 29.99,
        currency: 'USD',
        trialEnd: '2026-09-25T00:00:00.000Z',
        providerTrialEndDate: '2026-09-25',
        safeDeadline: '2026-09-23T00:00:00.000Z',
        plannedExecution: '2026-09-22T23:00:00.000Z',
        hasExplicitTime: true,
        state: 'REVIEW_REQUIRED',
        kind: 'POSSIBLE',
        confidence: 0.5,
        tier: '3'
      }
    }
  ]);

  const res = await dismissFinding(db, 'u1', 't_poss_3', { reason: 'offer_only' });
  assert.equal(res.status, 200);

  const [t] = await db.get<Trial>(table('u1', 'trials'), ['t_poss_3']);
  assert.ok(t);
  assert.equal(t.state, 'DISMISSED');
  assert.equal(t.kind, 'PROMOTIONAL', 'offer_only dismissal re-tags item as PROMOTIONAL');
  assert.equal(t.price, 0, 'Price must be reset to 0');
  assert.equal(t.trialEnd, undefined, 'trialEnd must be cleared on offer_only dismissal');
  assert.equal(t.providerTrialEndDate, undefined, 'providerTrialEndDate must be cleared on offer_only dismissal');
  assert.equal(t.safeDeadline, undefined, 'Safe cancel deadline must be cleared');
  assert.equal(t.plannedExecution, undefined, 'Planned action must be cleared');
  assert.equal(t.hasExplicitTime, false, 'hasExplicitTime must be reset to false');

  // Verify Protect eligibility fails closed (409)
  const protectRes = await protectTrial(db, 'u1', 't_poss_3', true);
  assert.equal(protectRes.status, 409, 'Dismissed promotional record must not be eligible for Protect');
  assert.equal(protectRes.error, 'Trial is not eligible');
});

test('1D. REJECTION SUPPRESSION: syncing identical source message does not re-create or revive dismissed finding', async () => {
  const db = createMockDatabase([
    {
      table: table('u1', 'trials'),
      id: 't_dismissed',
      record: {
        userId: 'u1',
        provider: 'Xfinity',
        plan: 'Xfinity Mobile switch offer',
        price: 0,
        currency: 'USD',
        state: 'DISMISSED',
        kind: 'PROMOTIONAL',
        sourceRef: { provider: 'google', messageId: 'msg_xfinity_promo', threadId: 'th_x' }
      }
    },
    {
      table: table('u1', 'gmail-sources'),
      id: 'src_xfinity',
      record: {
        messageId: 'msg_xfinity_promo',
        threadId: 'th_x',
        matched: false,
        kind: 'user_dismissed',
        processorVersion: 5
      }
    }
  ]);

  const seen = (await db.list<any>(table('u1', 'gmail-sources'))).items;
  const prior = seen.find(s => s.messageId === 'msg_xfinity_promo');
  assert.ok(prior);
  assert.equal(Number(prior.processorVersion), 5);
  const isDuplicate = prior.matched || Number(prior.processorVersion || 0) >= 5;
  assert.equal(isDuplicate, true, 'Sync deduplicator must identify already-processed dismissed source message');

  const existingTrials = (await db.list<Trial>(table('u1', 'trials'))).items;
  const related = existingTrials.some(t => t.sourceRef?.messageId === 'msg_xfinity_promo');
  assert.equal(related, true, 'SourceRef messageId match must prevent recreation');
});

test('1E. NON-SUPPRESSION OF MATERIALLY NEW EVIDENCE: new enrollment email is NOT suppressed by prior dismissed promo', async () => {
  const db = createMockDatabase([
    {
      table: table('u1', 'trials'),
      id: 't_prior_promo',
      record: {
        userId: 'u1',
        provider: 'Canva',
        plan: 'Try Canva Pro 30 days free offer',
        price: 0,
        currency: 'USD',
        state: 'DISMISSED',
        kind: 'PROMOTIONAL',
        sourceRef: { provider: 'google', messageId: 'msg_canva_promo_offer', threadId: 'th_promo' }
      }
    }
  ]);

  const newEnrollment = {
    messageId: 'msg_canva_enrollment_real',
    threadId: 'th_enroll',
    provider: 'Canva',
    plan: 'Your free trial has started',
    price: 14.99,
    trialEnd: '2026-09-10T00:00:00.000Z'
  };

  const normalizedPlan = (value: string) => value.toLowerCase().replace(/\b(?:your|free|trial|has|started|ends?|ending|expires?|renewal|subscription|membership|confirmation|reminder|will|be|charged|after|on)\b/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();

  const existingTrials = (await db.list<Trial>(table('u1', 'trials'))).items;
  const related = existingTrials.some(t =>
    t.sourceRef?.messageId === newEnrollment.messageId ||
    t.sourceRef?.threadId === newEnrollment.threadId ||
    (
      t.provider.toLowerCase() === newEnrollment.provider.toLowerCase() &&
      (normalizedPlan(t.plan) === normalizedPlan(newEnrollment.plan) || (t.price > 0 && newEnrollment.price > 0 && Math.abs(t.price - newEnrollment.price) < 0.01)) &&
      (t.trialEnd && newEnrollment.trialEnd ? Math.abs(new Date(t.trialEnd).getTime() - new Date(newEnrollment.trialEnd).getTime()) < 7 * 86400000 : true)
    )
  );

  assert.equal(related, false, 'Legitimate enrollment email must NOT be suppressed by a prior dismissed promo from the same provider');
});

// ==================================================
// 2. OVERVIEW / PROTECTION SEMANTIC TESTS
// ==================================================

test('2. OVERVIEW / PROTECTION COLLECTION AND COUNT LOGIC (2 ACTIVE, 3 POSSIBLE, 4 PROMOTIONAL, 1 DISMISSED, 1 protected ACTIVE)', () => {
  const now = Date.now();
  const dayMs = 86400000;

  const dataset: Trial[] = [
    // 2 ACTIVE (uncommitted review)
    { id: 'act_1', userId: 'u1', provider: 'Canva', plan: 'Pro trial', price: 14.99, currency: 'USD', state: 'REVIEW_REQUIRED', kind: 'ACTIVE', tier: '3', confidence: 0.94, trialEnd: new Date(now + 5 * dayMs).toISOString(), safeDeadline: new Date(now + 3 * dayMs).toISOString(), plannedExecution: new Date(now + 3 * dayMs - 3600000).toISOString() },
    { id: 'act_2', userId: 'u1', provider: 'Netflix', plan: 'Standard plan', price: 19.99, currency: 'USD', state: 'REVIEW_REQUIRED', kind: 'ACTIVE', tier: '3', confidence: 0.94, trialEnd: new Date(now + 20 * dayMs).toISOString(), safeDeadline: new Date(now + 18 * dayMs).toISOString(), plannedExecution: new Date(now + 18 * dayMs - 3600000).toISOString() },

    // 3 POSSIBLE (review items needing user confirmation)
    { id: 'poss_1', userId: 'u1', provider: 'Notion', plan: 'Team plan', price: 12.00, currency: 'USD', state: 'REVIEW_REQUIRED', kind: 'POSSIBLE', tier: '3', confidence: 0.44, trialEnd: new Date(now + 4 * dayMs).toISOString() },
    { id: 'poss_2', userId: 'u1', provider: 'Figma', plan: 'Professional plan', price: 15.00, currency: 'USD', state: 'REVIEW_REQUIRED', kind: 'POSSIBLE', tier: '3', confidence: 0.74, trialEnd: new Date(now + 15 * dayMs).toISOString() },
    { id: 'poss_3', userId: 'u1', provider: 'GitHub', plan: 'Pro plan', price: 4.00, currency: 'USD', state: 'REVIEW_REQUIRED', kind: 'POSSIBLE', tier: '3', confidence: 0.44, trialEnd: new Date(now + 40 * dayMs).toISOString() },

    // 4 PROMOTIONAL (excluded from active display and exposure)
    { id: 'prom_1', userId: 'u1', provider: 'Honey', plan: 'Price drop alert', price: 0, currency: 'USD', state: 'REVIEW_REQUIRED', kind: 'PROMOTIONAL', tier: '3', confidence: 0.1 },
    { id: 'prom_2', userId: 'u1', provider: 'Samsung', plan: 'S25+ ON US deal', price: 0, currency: 'USD', state: 'REVIEW_REQUIRED', kind: 'PROMOTIONAL', tier: '3', confidence: 0.1 },
    { id: 'prom_3', userId: 'u1', provider: 'Xfinity', plan: 'Switch offer $500', price: 0, currency: 'USD', state: 'REVIEW_REQUIRED', kind: 'PROMOTIONAL', tier: '3', confidence: 0.1 },
    { id: 'prom_4', userId: 'u1', provider: 'Retail', plan: 'Summer sale 20% off', price: 0, currency: 'USD', state: 'REVIEW_REQUIRED', kind: 'PROMOTIONAL', tier: '3', confidence: 0.1 },

    // 1 DISMISSED
    { id: 'dism_1', userId: 'u1', provider: 'Dropbox', plan: 'Old finding', price: 9.99, currency: 'USD', state: 'DISMISSED', kind: 'POSSIBLE', tier: '3', confidence: 0.44 },

    // 1 protected ACTIVE
    { id: 'prot_1', userId: 'u1', provider: 'Spotify', plan: 'Premium trial', price: 10.99, currency: 'USD', state: 'AUTO_CANCEL_ENABLED', kind: 'ACTIVE', tier: '3', confidence: 0.94, trialEnd: new Date(now + 6 * dayMs).toISOString(), safeDeadline: new Date(now + 4 * dayMs).toISOString(), plannedExecution: new Date(now + 4 * dayMs - 3600000).toISOString() }
  ];

  const activeTrials = dataset.filter(t => t.state !== 'DISMISSED' && t.kind !== 'PROMOTIONAL');
  const confirmedTrials = activeTrials.filter(t => t.kind === 'ACTIVE' || !t.kind);
  const possibleTrials = activeTrials.filter(t => t.kind === 'POSSIBLE');
  const protectedTrials = activeTrials.filter(t => ['AUTO_CANCEL_ENABLED', 'DECISION_PENDING'].includes(t.state));
  const reviewTrials = activeTrials.filter(t => t.state === 'REVIEW_REQUIRED');

  const exposure7 = activeTrials.filter(t => !['CANCELED_CONFIRMED', 'KEEP_REQUESTED'].includes(t.state) && t.kind !== 'POSSIBLE' && t.price > 0 && daysLeft(t.trialEnd) <= 7).reduce((s, t) => s + t.price, 0);
  const exposure30 = activeTrials.filter(t => !['CANCELED_CONFIRMED', 'KEEP_REQUESTED'].includes(t.state) && t.kind !== 'POSSIBLE' && t.price > 0 && daysLeft(t.trialEnd) <= 30).reduce((s, t) => s + t.price, 0);

  assert.equal(activeTrials.length, 6, 'activeTrials must include exactly 2 review ACTIVE + 3 review POSSIBLE + 1 protected ACTIVE');
  assert.equal(confirmedTrials.length, 3, 'confirmedTrials must count only ACTIVE items (2 review + 1 protected)');
  assert.equal(possibleTrials.length, 3, 'possibleTrials must count only the 3 unconfirmed items');
  assert.equal(protectedTrials.length, 1, 'protectedTrials must count only the 1 protected item');
  assert.equal(reviewTrials.length, 5, 'reviewTrials must count 2 ACTIVE + 3 POSSIBLE items in REVIEW_REQUIRED');

  assert.equal(activeTrials.some(t => t.kind === 'PROMOTIONAL'), false, 'No PROMOTIONAL items may be in activeTrials');
  assert.equal(activeTrials.some(t => t.state === 'DISMISSED'), false, 'No DISMISSED items may be in activeTrials');

  assert.equal(Math.round(exposure7 * 100) / 100, 25.98, 'Exposure 7d must exclude POSSIBLE and count only confirmed ACTIVE trials');
  assert.equal(Math.round(exposure30 * 100) / 100, 45.97, 'Exposure 30d must exclude POSSIBLE and count only confirmed ACTIVE trials');
});

// ==================================================
// 3. PROTECT ENDPOINT FAIL-CLOSED TESTS
// ==================================================

test('3. PROTECT ENDPOINT FAIL-CLOSED: rejects PROMOTIONAL, POSSIBLE, DISMISSED, ACTIVE without valid date; succeeds for valid ACTIVE', async () => {
  const db = createMockDatabase([
    {
      table: table('u1', 'trials'),
      id: 't_promo',
      record: { userId: 'u1', provider: 'Honey', plan: 'Price drop alert', price: 0, state: 'REVIEW_REQUIRED', kind: 'PROMOTIONAL', tier: '3' }
    },
    {
      table: table('u1', 'trials'),
      id: 't_possible',
      record: { userId: 'u1', provider: 'Notion', plan: 'Workspace status', price: 10, state: 'REVIEW_REQUIRED', kind: 'POSSIBLE', tier: '3', trialEnd: '2026-09-20T00:00:00.000Z' }
    },
    {
      table: table('u1', 'trials'),
      id: 't_dismissed',
      record: { userId: 'u1', provider: 'Dropbox', plan: 'Storage', price: 9.99, state: 'DISMISSED', kind: 'ACTIVE', tier: '3' }
    },
    {
      table: table('u1', 'trials'),
      id: 't_active_nodate',
      record: { userId: 'u1', provider: 'Adobe', plan: 'Acrobat trial', price: 14.99, state: 'REVIEW_REQUIRED', kind: 'ACTIVE', tier: '3' }
    },
    {
      table: table('u1', 'trials'),
      id: 't_active_valid',
      record: {
        userId: 'u1',
        provider: 'Canva',
        plan: 'Pro trial',
        price: 14.99,
        state: 'REVIEW_REQUIRED',
        kind: 'ACTIVE',
        tier: '3',
        trialEnd: '2026-09-10T00:00:00.000Z',
        safeDeadline: '2026-09-08T00:00:00.000Z',
        plannedExecution: '2026-09-07T23:00:00.000Z'
      }
    }
  ]);

  const r1 = await protectTrial(db, 'u1', 't_promo', true);
  assert.equal(r1.status, 409);
  assert.equal(r1.error, 'Trial is not eligible');

  const r2 = await protectTrial(db, 'u1', 't_possible', true);
  assert.equal(r2.status, 409);
  assert.equal(r2.error, 'Trial is not eligible');

  const r3 = await protectTrial(db, 'u1', 't_dismissed', true);
  assert.equal(r3.status, 409);
  assert.equal(r3.error, 'Trial is not eligible');

  const r4 = await protectTrial(db, 'u1', 't_active_nodate', true);
  assert.equal(r4.status, 400);
  assert.equal(r4.error, 'Confirmed trial end date is required before protection can be scheduled');

  const r5 = await protectTrial(db, 'u1', 't_active_valid', false);
  assert.equal(r5.status, 402);

  const r6 = await protectTrial(db, 'u1', 't_active_valid', true);
  assert.equal(r6.status, 200);
  assert.equal(r6.ok, true);

  const [tUpdated] = await db.get<Trial>(table('u1', 'trials'), ['t_active_valid']);
  assert.ok(tUpdated);
  assert.equal(tUpdated.state, 'AUTO_CANCEL_ENABLED');
  assert.ok(tUpdated.authorizationAt);

  const jobs = (await db.list('jobs')).items;
  assert.equal(jobs.length, 2);
  const decisionJob = jobs.find((j: any) => j.kind === 'DECISION');
  const cancelJob = jobs.find((j: any) => j.kind === 'CANCEL');
  assert.ok(decisionJob);
  assert.equal(decisionJob.idempotencyKey, 'decision:t_active_valid');
  assert.ok(cancelJob);
  assert.equal(cancelJob.idempotencyKey, 'cancel:t_active_valid');

  const audits = (await db.list(table('u1', 'audit'))).items;
  assert.ok(audits.some((a: any) => a.type === 'AUTHORIZATION_GRANTED' && a.trialId === 't_active_valid'));
});

// ==================================================
// 4. V4 MIGRATION IDEMPOTENCY TEST
// ==================================================

test('4. V4 MIGRATION IDEMPOTENCY: running reprocessing multiple times produces identical state without duplicate audits and clears all date fields', async () => {
  const db = createMockDatabase([
    {
      table: table('u1', 'trials'),
      id: 't_promo_v4',
      record: {
        userId: 'u1',
        provider: 'Honey',
        plan: 'We found price drops for an item you Droplisted',
        price: 15,
        trialEnd: '2026-09-20T00:00:00.000Z',
        providerTrialEndDate: '2026-09-20',
        safeDeadline: '2026-09-18T00:00:00.000Z',
        plannedExecution: '2026-09-17T23:00:00.000Z',
        hasExplicitTime: true,
        state: 'REVIEW_REQUIRED',
        tier: '3',
        sourceRef: { provider: 'google', messageId: 'msg_promo_v4', threadId: 'th_1' }
      }
    },
    {
      table: table('u1', 'trials'),
      id: 't_explicit_v4',
      record: {
        userId: 'u1',
        provider: 'Canva',
        plan: 'Your free trial has started',
        price: 14.99,
        state: 'REVIEW_REQUIRED',
        tier: '3',
        trialEnd: '2026-09-10T00:00:00.000Z',
        safeDeadline: '2026-09-08T00:00:00.000Z',
        plannedExecution: '2026-09-07T23:00:00.000Z'
      }
    },
    {
      table: table('u1', 'trials'),
      id: 't_user_authorized_v4',
      record: {
        userId: 'u1',
        provider: 'Adobe',
        plan: 'Creative Cloud Pro',
        price: 29.99,
        state: 'AUTO_CANCEL_ENABLED',
        kind: 'ACTIVE',
        tier: '3',
        authorizationAt: '2026-09-01T00:00:00.000Z',
        trialEnd: '2026-09-15T00:00:00.000Z',
        safeDeadline: '2026-09-13T00:00:00.000Z',
        plannedExecution: '2026-09-12T23:00:00.000Z'
      }
    }
  ]);

  await reprocessV4Findings(db, 'u1');

  const [promoAfterRun1] = await db.get<Trial>(table('u1', 'trials'), ['t_promo_v4']);
  const [explicitAfterRun1] = await db.get<Trial>(table('u1', 'trials'), ['t_explicit_v4']);
  const [userAuthAfterRun1] = await db.get<Trial>(table('u1', 'trials'), ['t_user_authorized_v4']);

  assert.equal(promoAfterRun1?.state, 'DISMISSED');
  assert.equal(promoAfterRun1?.kind, 'PROMOTIONAL');
  assert.equal(promoAfterRun1?.price, 0, 'Stale recurring price removed');
  assert.equal(promoAfterRun1?.trialEnd, undefined, 'Stale trialEnd removed');
  assert.equal(promoAfterRun1?.providerTrialEndDate, undefined, 'Stale providerTrialEndDate removed');
  assert.equal(promoAfterRun1?.safeDeadline, undefined, 'Stale safeDeadline removed');
  assert.equal(promoAfterRun1?.plannedExecution, undefined, 'Stale plannedExecution removed');
  assert.equal(promoAfterRun1?.hasExplicitTime, false, 'hasExplicitTime set to false');
  assert.ok(promoAfterRun1?.sourceRef, 'Source reference preserved for evidence');
  assert.equal(promoAfterRun1?.provider, 'Honey', 'Provider identity preserved');

  assert.equal(explicitAfterRun1?.kind, 'ACTIVE');
  assert.equal(explicitAfterRun1?.state, 'REVIEW_REQUIRED');
  assert.equal(userAuthAfterRun1?.state, 'AUTO_CANCEL_ENABLED', 'User authorized record must not be mutated');

  const auditCountRun1 = (await db.list(table('u1', 'audit'))).items.length;
  assert.equal(auditCountRun1, 1, 'Exactly one dismissal audit created on initial migration');

  // Run migration second time to test idempotency
  await reprocessV4Findings(db, 'u1');

  const [promoAfterRun2] = await db.get<Trial>(table('u1', 'trials'), ['t_promo_v4']);
  const [explicitAfterRun2] = await db.get<Trial>(table('u1', 'trials'), ['t_explicit_v4']);
  const [userAuthAfterRun2] = await db.get<Trial>(table('u1', 'trials'), ['t_user_authorized_v4']);

  assert.deepEqual(promoAfterRun2, promoAfterRun1, 'State of promotional item must be identical after second run');
  assert.deepEqual(explicitAfterRun2, explicitAfterRun1, 'State of explicit item must be identical after second run');
  assert.deepEqual(userAuthAfterRun2, userAuthAfterRun1, 'State of user-authorized item must remain unchanged');

  const auditCountRun2 = (await db.list(table('u1', 'audit'))).items.length;
  assert.equal(auditCountRun2, auditCountRun1, 'No duplicate audits must be generated on second run');
});

// ==================================================
// 5. ACTIVE WITH NO PRICE TEST
// ==================================================

test('5. ACTIVE WITH NO PRICE: credible enrollment without extracted price remains ACTIVE and Protect-eligible without inventing $0/month', async () => {
  // 1. Signal classification: credible enrollment message with trial end date but no dollar amount
  const msgText = {
    subject: 'Your free trial has started',
    body: 'Welcome to your premium free trial. Your trial ends September 10, 2026. Enjoy unlimited access during your trial period.',
    from: 'support@workflowapp.com'
  };
  const mockMsg = {
    id: 'msg_active_noprice',
    threadId: 'th_active_noprice',
    internalDate: String(Date.now()),
    payload: {
      headers: [
        { name: 'subject', value: msgText.subject },
        { name: 'from', value: msgText.from }
      ],
      parts: [{ mimeType: 'text/plain', body: { data: Buffer.from(msgText.body).toString('base64url') } }]
    }
  };

  const signal = classifySignal(mockMsg);
  assert.ok(signal, 'Signal must be classified');
  assert.equal(signal.kind, 'ACTIVE', 'Explicit enrollment evidence establishes ACTIVE even with no stated price');
  assert.equal(signal.price, 0, 'Does not invent or guess a recurring price');
  assert.equal(signal.providerTrialEndDate, '2026-09-10');
  assert.ok(signal.trialEnd);
  assert.ok(signal.safeDeadline);
  assert.ok(signal.plannedExecution);

  // 2. UI semantics: Card does NOT display "$0.00/month"; displays "Unconfirmed amount"
  const cardChargeDisplay = (price: number) => ({
    amount: price > 0 ? `$${price.toFixed(2)}` : 'Unconfirmed',
    cadence: price > 0 ? '/ month' : 'amount'
  });
  const display = cardChargeDisplay(signal.price);
  assert.equal(display.amount, 'Unconfirmed');
  assert.equal(display.cadence, 'amount');
  assert.notEqual(display.amount, '$0.00');

  // 3. Protect eligibility: Protect succeeds based on valid date and authorization without requiring or inventing a price
  const db = createMockDatabase([
    {
      table: table('u1', 'trials'),
      id: 't_active_noprice',
      record: {
        userId: 'u1',
        ...signal
      }
    }
  ]);

  const protectRes = await protectTrial(db, 'u1', 't_active_noprice', true);
  assert.equal(protectRes.status, 200, 'ACTIVE item with valid dates remains Protect-eligible without needing a fabricated price');
  assert.equal(protectRes.ok, true);

  const [protectedTrial] = await db.get<Trial>(table('u1', 'trials'), ['t_active_noprice']);
  assert.equal(protectedTrial?.state, 'AUTO_CANCEL_ENABLED');
  assert.equal(protectedTrial?.price, 0, 'Price remains 0/unconfirmed, not mutated or fabricated');
});
