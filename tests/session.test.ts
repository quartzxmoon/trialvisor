import assert from 'node:assert/strict';
import test from 'node:test';
import {
  evaluateSession,
  getSessionId,
  initSession,
  invalidateSession,
  sessionTable,
  SESSION_ABSOLUTE_LIFETIME_MS,
  SESSION_IDLE_TIMEOUT_MS,
  SENSITIVE_ACTION_MAX_AGE_MS,
  type SessionDatabase,
  type UserSession
} from '../backend/session.ts';

const createMockDatabase = (seed: Array<{ table: string; id: string; record: Record<string, unknown> }> = []) => {
  const store = new Map<string, Map<string, Record<string, unknown>>>();
  let nextIdCounter = 1;

  for (const s of seed) {
    if (!store.has(s.table)) store.set(s.table, new Map());
    store.get(s.table)!.set(s.id, { ...s.record, id: s.id });
  }

  const database: SessionDatabase = {
    async add(table: string, records: Array<Record<string, unknown>>) {
      if (!store.has(table)) store.set(table, new Map());
      const tbl = store.get(table)!;
      return records.map(r => {
        const id = 'sess_' + (nextIdCounter++);
        tbl.set(id, { ...r, id });
        return id;
      });
    },
    async update(table: string, items: Array<{ id: string; record: Record<string, unknown> }>) {
      if (!store.has(table)) store.set(table, new Map());
      const tbl = store.get(table)!;
      return items.map(item => {
        if (!tbl.has(item.id)) return false;
        tbl.set(item.id, { ...item.record, id: item.id });
        return true;
      });
    },
    async list<T = Record<string, unknown>>(table: string, options?: { limit?: number; nextToken?: string }) {
      const tbl = store.get(table);
      if (!tbl) return { items: [] };
      const all = Array.from(tbl.values()) as Array<T & { id: string }>;
      const offset = Number(options?.nextToken || 0);
      const limit = options?.limit || 100;
      const items = all.slice(offset, offset + limit);
      const nextToken = offset + limit < all.length ? String(offset + limit) : undefined;
      return { items, nextToken };
    },
    async get<T = Record<string, unknown>>(table: string, ids: string[]) {
      const tbl = store.get(table);
      if (!tbl) return ids.map(() => null);
      return ids.map(id => (tbl.get(id) ? ({ ...tbl.get(id) } as T & { id: string }) : null));
    },
    async delete(table: string, ids: string[]) {
      const tbl = store.get(table);
      if (!tbl) return ids.map(() => false);
      return ids.map(id => tbl.delete(id));
    }
  };

  return { database, store };
};

test('A. VALID SESSION: fresh session succeeds on authenticated request', async () => {
  const { database } = createMockDatabase();
  const init = await initSession(database, 'user-1', '2026-09-05T12:00:00.000Z');
  const now = new Date('2026-09-05T12:05:00.000Z').getTime();

  const res = await evaluateSession(database, 'user-1', init.sessionId!, { touchActivity: true }, now);
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.session.userId, 'user-1');
    assert.equal(res.session.id, init.sessionId);
    assert.equal(res.session.lastActiveAt, new Date(now).toISOString());
  }
});

test('B. IDLE TIMEOUT: >30m inactive returns 401 session_idle_timeout and invalidates record', async () => {
  const nowTime = new Date('2026-09-05T12:00:00.000Z').getTime();
  const createdStr = new Date(nowTime - 40 * 60 * 1000).toISOString();
  const lastActiveStr = new Date(nowTime - 31 * 60 * 1000).toISOString(); // 31 minutes ago (>30m)

  const { database, store } = createMockDatabase([{
    table: sessionTable('user-1'),
    id: 's-idle',
    record: { userId: 'user-1', createdAt: createdStr, lastActiveAt: lastActiveStr }
  }]);

  const res = await evaluateSession(database, 'user-1', 's-idle', { touchActivity: true }, nowTime);
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.status, 401);
    assert.equal(res.code, 'session_idle_timeout');
  }

  const stored = store.get(sessionTable('user-1'))?.get('s-idle') as UserSession;
  assert.ok(stored.invalidatedAt, 'session must be marked invalidated in database');
  assert.equal(stored.reason, 'idle_timeout');
});

test('C. ABSOLUTE TIMEOUT: >12h old returns 401 session_absolute_timeout even if recently active', async () => {
  const nowTime = new Date('2026-09-05T13:00:00.000Z').getTime();
  const createdStr = new Date(nowTime - (12 * 60 * 60 * 1000 + 60000)).toISOString(); // 12h 1m ago
  const recentActiveStr = new Date(nowTime - 2 * 60 * 1000).toISOString(); // active 2 min ago

  const { database, store } = createMockDatabase([{
    table: sessionTable('user-1'),
    id: 's-abs',
    record: { userId: 'user-1', createdAt: createdStr, lastActiveAt: recentActiveStr }
  }]);

  const res = await evaluateSession(database, 'user-1', 's-abs', { touchActivity: true }, nowTime);
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.status, 401);
    assert.equal(res.code, 'session_absolute_timeout');
  }

  const stored = store.get(sessionTable('user-1'))?.get('s-abs') as UserSession;
  assert.ok(stored.invalidatedAt, 'session must be marked invalidated upon absolute timeout');
  assert.equal(stored.reason, 'absolute_timeout');
});

test('D. SIGN-OUT INVALIDATION: invalidate session and replay returns 401 session_expired', async () => {
  const { database } = createMockDatabase();
  const init = await initSession(database, 'user-1', '2026-09-05T12:00:00.000Z');
  const sid = init.sessionId!;

  // 1. Initial valid check
  const now1 = new Date('2026-09-05T12:05:00.000Z').getTime();
  const res1 = await evaluateSession(database, 'user-1', sid, {}, now1);
  assert.equal(res1.ok, true);

  // 2. Invalidate single session
  await invalidateSession(database, 'user-1', sid, false, '2026-09-05T12:06:00.000Z');

  // 3. Replay invalidated session
  const res2 = await evaluateSession(database, 'user-1', sid, {}, new Date('2026-09-05T12:07:00.000Z').getTime());
  assert.equal(res2.ok, false);
  if (!res2.ok) {
    assert.equal(res2.status, 401);
    assert.equal(res2.code, 'session_expired');
  }
});

test('E. MULTIPLE INDEPENDENT SESSIONS: activity in B does not refresh A, invalidating A does not invalidate B', async () => {
  const baseTime = new Date('2026-09-05T12:00:00.000Z').getTime();
  const initialA = new Date(baseTime).toISOString();
  const initialB = new Date(baseTime).toISOString();

  const { database, store } = createMockDatabase([
    { table: sessionTable('user-1'), id: 'sess-A', record: { userId: 'user-1', createdAt: initialA, lastActiveAt: initialA } },
    { table: sessionTable('user-1'), id: 'sess-B', record: { userId: 'user-1', createdAt: initialB, lastActiveAt: initialB } }
  ]);

  // Activity in B at +10 min
  const timeB = baseTime + 10 * 60 * 1000;
  const resB = await evaluateSession(database, 'user-1', 'sess-B', { touchActivity: true }, timeB);
  assert.equal(resB.ok, true);

  // Verify A's lastActiveAt was NOT refreshed
  const storedA = store.get(sessionTable('user-1'))!.get('sess-A') as UserSession;
  const storedB = store.get(sessionTable('user-1'))!.get('sess-B') as UserSession;
  assert.equal(storedA.lastActiveAt, initialA, 'Session A lastActiveAt must remain unrefreshed');
  assert.equal(storedB.lastActiveAt, new Date(timeB).toISOString(), 'Session B lastActiveAt must be updated');

  // Invalidate A
  await invalidateSession(database, 'user-1', 'sess-A', false, new Date(timeB + 1000).toISOString());

  // A is expired, B is still valid
  const resAAfter = await evaluateSession(database, 'user-1', 'sess-A', {}, timeB + 2000);
  assert.equal(resAAfter.ok, false);
  if (!resAAfter.ok) assert.equal(resAAfter.code, 'session_expired');

  const resBAfter = await evaluateSession(database, 'user-1', 'sess-B', {}, timeB + 2000);
  assert.equal(resBAfter.ok, true);
});

test('F. SIGN OUT EVERYWHERE: everywhere=true invalidates all sessions for authenticated user', async () => {
  const baseTime = new Date('2026-09-05T12:00:00.000Z').getTime();
  const { database, store } = createMockDatabase([
    { table: sessionTable('user-1'), id: 'sess-1', record: { userId: 'user-1', createdAt: new Date(baseTime).toISOString(), lastActiveAt: new Date(baseTime).toISOString() } },
    { table: sessionTable('user-1'), id: 'sess-2', record: { userId: 'user-1', createdAt: new Date(baseTime).toISOString(), lastActiveAt: new Date(baseTime).toISOString() } },
    { table: sessionTable('user-2'), id: 'sess-other', record: { userId: 'user-2', createdAt: new Date(baseTime).toISOString(), lastActiveAt: new Date(baseTime).toISOString() } }
  ]);

  await invalidateSession(database, 'user-1', undefined, true, '2026-09-05T12:15:00.000Z');

  const s1 = store.get(sessionTable('user-1'))!.get('sess-1') as UserSession;
  const s2 = store.get(sessionTable('user-1'))!.get('sess-2') as UserSession;
  const sOther = store.get(sessionTable('user-2'))!.get('sess-other') as UserSession;

  assert.ok(s1.invalidatedAt, 'user-1 sess-1 must be invalidated');
  assert.ok(s2.invalidatedAt, 'user-1 sess-2 must be invalidated');
  assert.equal(sOther.invalidatedAt, undefined, 'user-2 sess-other must remain untouched');
});

test('G. HEARTBEAT: updates only target session, cannot revive invalidated/expired, tenant isolation enforced', async () => {
  const baseTime = new Date('2026-09-05T12:00:00.000Z').getTime();
  const { database } = createMockDatabase([
    { table: sessionTable('user-1'), id: 'valid-1', record: { userId: 'user-1', createdAt: new Date(baseTime).toISOString(), lastActiveAt: new Date(baseTime).toISOString() } },
    { table: sessionTable('user-1'), id: 'inval-1', record: { userId: 'user-1', createdAt: new Date(baseTime).toISOString(), lastActiveAt: new Date(baseTime).toISOString(), invalidatedAt: new Date(baseTime + 1000).toISOString() } },
    { table: sessionTable('user-1'), id: 'expired-1', record: { userId: 'user-1', createdAt: new Date(baseTime).toISOString(), lastActiveAt: new Date(baseTime - 35 * 60 * 1000).toISOString() } },
    { table: sessionTable('user-2'), id: 'tenant-2-sess', record: { userId: 'user-2', createdAt: new Date(baseTime).toISOString(), lastActiveAt: new Date(baseTime).toISOString() } }
  ]);

  // 1. Valid heartbeat succeeds and updates only target
  const hbTime = baseTime + 60 * 1000;
  const hbRes = await evaluateSession(database, 'user-1', 'valid-1', { touchActivity: true }, hbTime);
  assert.equal(hbRes.ok, true);
  if (hbRes.ok) assert.equal(hbRes.session.lastActiveAt, new Date(hbTime).toISOString());

  // 2. Invalidated session cannot revive
  const invalRes = await evaluateSession(database, 'user-1', 'inval-1', { touchActivity: true }, hbTime);
  assert.equal(invalRes.ok, false);
  if (!invalRes.ok) assert.equal(invalRes.code, 'session_expired');

  // 3. Expired session cannot revive
  const expRes = await evaluateSession(database, 'user-1', 'expired-1', { touchActivity: true }, hbTime);
  assert.equal(expRes.ok, false);
  if (!expRes.ok) assert.equal(expRes.code, 'session_idle_timeout');

  // 4. Another tenant session cannot be accessed or touched
  const tenantRes = await evaluateSession(database, 'user-1', 'tenant-2-sess', { touchActivity: true }, hbTime);
  assert.equal(tenantRes.ok, false);
  if (!tenantRes.ok) assert.equal(tenantRes.code, 'session_expired');
});

test('H. PASSIVE READ: passive requests do not update lastActiveAt', async () => {
  const baseTime = new Date('2026-09-05T12:00:00.000Z').getTime();
  const initialTime = new Date(baseTime).toISOString();
  const { database, store } = createMockDatabase([
    { table: sessionTable('user-1'), id: 'sess-read', record: { userId: 'user-1', createdAt: initialTime, lastActiveAt: initialTime } }
  ]);

  const readTime = baseTime + 5 * 60 * 1000;
  const res = await evaluateSession(database, 'user-1', 'sess-read', { touchActivity: false }, readTime);
  assert.equal(res.ok, true);

  const stored = store.get(sessionTable('user-1'))!.get('sess-read') as UserSession;
  assert.equal(stored.lastActiveAt, initialTime, 'lastActiveAt must NOT be updated on passive read');
});

test('I. SENSITIVE ACTION: requires recent activity within 15m; does not re-authenticate', async () => {
  const baseTime = new Date('2026-09-05T12:00:00.000Z').getTime();
  const { database } = createMockDatabase([
    // Active 10 min ago (within 15m)
    { table: sessionTable('user-1'), id: 'sess-recent', record: { userId: 'user-1', createdAt: new Date(baseTime - 10 * 60 * 1000).toISOString(), lastActiveAt: new Date(baseTime - 10 * 60 * 1000).toISOString() } },
    // Active 16 min ago (>15m, but <30m idle timeout)
    { table: sessionTable('user-1'), id: 'sess-stale', record: { userId: 'user-1', createdAt: new Date(baseTime - 20 * 60 * 1000).toISOString(), lastActiveAt: new Date(baseTime - 16 * 60 * 1000).toISOString() } }
  ]);

  // Recent activity passes sensitive check
  const resRecent = await evaluateSession(database, 'user-1', 'sess-recent', { touchActivity: true, sensitive: true }, baseTime);
  assert.equal(resRecent.ok, true);

  // Stale activity fails with 403 recent_activity_required (not 401 reauthentication)
  const resStale = await evaluateSession(database, 'user-1', 'sess-stale', { touchActivity: true, sensitive: true }, baseTime);
  assert.equal(resStale.ok, false);
  if (!resStale.ok) {
    assert.equal(resStale.status, 403);
    assert.equal(resStale.code, 'recent_activity_required');
  }
});

test('SENSITIVE CHECK ORDER: stale sensitive request cannot make itself recent by touching activity', async () => {
  const baseTime = new Date('2026-09-05T12:00:00.000Z').getTime();
  const preRequestActive = new Date(baseTime - 16 * 60 * 1000).toISOString(); // 16 min ago

  const { database, store } = createMockDatabase([
    { table: sessionTable('user-1'), id: 'sess-order', record: { userId: 'user-1', createdAt: new Date(baseTime - 25 * 60 * 1000).toISOString(), lastActiveAt: preRequestActive } }
  ]);

  // Request attempts touchActivity: true and sensitive: true
  const res1 = await evaluateSession(database, 'user-1', 'sess-order', { touchActivity: true, sensitive: true }, baseTime);
  assert.equal(res1.ok, false);
  if (!res1.ok) {
    assert.equal(res1.status, 403);
    assert.equal(res1.code, 'recent_activity_required');
  }

  // Verify database record lastActiveAt was NOT modified
  const stored = store.get(sessionTable('user-1'))!.get('sess-order') as UserSession;
  assert.equal(stored.lastActiveAt, preRequestActive, 'lastActiveAt must NOT be updated when sensitive check fails');

  // Immediately repeating the request must STILL fail with 403
  const res2 = await evaluateSession(database, 'user-1', 'sess-order', { touchActivity: true, sensitive: true }, baseTime + 1000);
  assert.equal(res2.ok, false);
  if (!res2.ok) {
    assert.equal(res2.status, 403);
    assert.equal(res2.code, 'recent_activity_required');
  }
});

test('SESSION ID TRANSPORT: URL query parameter session IDs are strictly rejected', () => {
  // 1. Query parameter ONLY -> must return undefined
  const reqWithQuery = { query: { sessionId: 'leak-in-url' } };
  assert.equal(getSessionId(reqWithQuery), undefined, 'URL query parameter sessionId must NOT be extracted');

  // 2. Query param + Header -> must extract ONLY from Header
  const reqWithBoth = {
    query: { sessionId: 'leak-in-url' },
    headers: { 'X-Session-Id': 'header-sid-123' }
  };
  assert.equal(getSessionId(reqWithBoth), 'header-sid-123');

  // 3. Header case-insensitive lookup
  const reqLowerHeader = {
    event: { headers: { 'x-session-id': 'lower-header-sid' } }
  };
  assert.equal(getSessionId(reqLowerHeader), 'lower-header-sid');

  // 4. JSON Body (allowed for explicit invalidate / POST payloads)
  const reqBody = { body: { sessionId: 'body-sid-456' } };
  assert.equal(getSessionId(reqBody), 'body-sid-456');
});
