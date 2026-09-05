import assert from 'node:assert/strict';
import test from 'node:test';
import {
  cleanupSessions,
  evaluateSession,
  getSessionId,
  initSession,
  invalidateSession,
  sessionTable,
  SESSION_ABSOLUTE_LIFETIME_MS,
  SESSION_IDLE_TIMEOUT_MS,
  SENSITIVE_ACTION_MAX_AGE_MS,
  INVALIDATED_SESSION_RETENTION_MS,
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

test('A. SINGLE-ACTIVE-SESSION FALLBACK REMOVED: missing session ID is rejected even if exactly one active session exists', async () => {
  const baseTime = new Date('2026-09-05T12:00:00.000Z').getTime();
  const { database } = createMockDatabase([
    { table: sessionTable('user-1'), id: 'sole-session', record: { userId: 'user-1', createdAt: new Date(baseTime).toISOString(), lastActiveAt: new Date(baseTime).toISOString() } }
  ]);

  // Request with no sessionId (e.g. missing X-Session-Id header) must be rejected
  const res = await evaluateSession(database, 'user-1', undefined, { touchActivity: true }, baseTime + 1000);
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.status, 401);
    assert.equal(res.code, 'session_expired');
  }

  // Whitespace-only sessionId must also be rejected
  const resWhitespace = await evaluateSession(database, 'user-1', '   ', { touchActivity: true }, baseTime + 1000);
  assert.equal(resWhitespace.ok, false);
  if (!resWhitespace.ok) {
    assert.equal(resWhitespace.status, 401);
    assert.equal(resWhitespace.code, 'session_expired');
  }
});

test('B. EXACT SESSION BINDING: valid user + exact active session ID succeeds', async () => {
  const baseTime = new Date('2026-09-05T12:00:00.000Z').getTime();
  const { database } = createMockDatabase([
    { table: sessionTable('user-1'), id: 'exact-sid-123', record: { userId: 'user-1', createdAt: new Date(baseTime).toISOString(), lastActiveAt: new Date(baseTime).toISOString() } }
  ]);

  const res = await evaluateSession(database, 'user-1', 'exact-sid-123', { touchActivity: true }, baseTime + 2000);
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.session.id, 'exact-sid-123');
    assert.equal(res.session.userId, 'user-1');
  }
});

test('C. NONEXISTENT SESSION ID: valid user with nonexistent session ID is rejected', async () => {
  const baseTime = new Date('2026-09-05T12:00:00.000Z').getTime();
  const { database } = createMockDatabase([
    { table: sessionTable('user-1'), id: 'real-session', record: { userId: 'user-1', createdAt: new Date(baseTime).toISOString(), lastActiveAt: new Date(baseTime).toISOString() } }
  ]);

  const res = await evaluateSession(database, 'user-1', 'nonexistent-session', { touchActivity: true }, baseTime + 1000);
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.status, 401);
    assert.equal(res.code, 'session_expired');
  }
});

test('D. TENANT ISOLATION: user A presenting session ID of user B is rejected', async () => {
  const baseTime = new Date('2026-09-05T12:00:00.000Z').getTime();
  const { database, store } = createMockDatabase([
    { table: sessionTable('user-B'), id: 'sess-user-B', record: { userId: 'user-B', createdAt: new Date(baseTime).toISOString(), lastActiveAt: new Date(baseTime).toISOString() } }
  ]);

  // user-A tries to authenticate using user-B's session ID
  const res = await evaluateSession(database, 'user-A', 'sess-user-B', { touchActivity: true }, baseTime + 5000);
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.status, 401);
    assert.equal(res.code, 'session_expired');
  }

  // Confirm user-B's record was never touched
  const userBRecord = store.get(sessionTable('user-B'))!.get('sess-user-B') as UserSession;
  assert.equal(userBRecord.lastActiveAt, new Date(baseTime).toISOString());
});

test('E. SESSION INITIALIZATION: creates new unique session without requiring existing session ID', async () => {
  const { database } = createMockDatabase();
  const init1 = await initSession(database, 'user-1', '2026-09-05T12:00:00.000Z');
  assert.ok(init1.sessionId, 'must generate sessionId');
  assert.equal(init1.idleTimeoutMs, SESSION_IDLE_TIMEOUT_MS);
  assert.equal(init1.absoluteLifetimeMs, SESSION_ABSOLUTE_LIFETIME_MS);

  // A second sign-in from another device creates a distinct unique session
  const init2 = await initSession(database, 'user-1', '2026-09-05T12:01:00.000Z');
  assert.ok(init2.sessionId, 'must generate second sessionId');
  assert.notEqual(init1.sessionId, init2.sessionId, 'sessions must be independently unique and not reused');
});

test('F. PAGINATED CLEANUP: paginates through 130 records and cleans stale sessions beyond page boundary', async () => {
  const nowTime = new Date('2026-09-05T12:00:00.000Z').getTime();
  const seed: Array<{ table: string; id: string; record: Record<string, unknown> }> = [];

  // 1. 30 active sessions (<12h old) -> PRESERVE
  for (let i = 0; i < 30; i++) {
    seed.push({
      table: sessionTable('user-1'),
      id: `active-${i}`,
      record: {
        userId: 'user-1',
        createdAt: new Date(nowTime - 2 * 3600000).toISOString(),
        lastActiveAt: new Date(nowTime - 10 * 60000).toISOString()
      }
    });
  }

  // 2. 50 expired sessions (>12h old, absolute timeout) -> DELETE
  for (let i = 0; i < 50; i++) {
    seed.push({
      table: sessionTable('user-1'),
      id: `expired-${i}`,
      record: {
        userId: 'user-1',
        createdAt: new Date(nowTime - 14 * 3600000).toISOString(),
        lastActiveAt: new Date(nowTime - 13 * 3600000).toISOString()
      }
    });
  }

  // 3. 20 recent invalidated sessions (<1h since invalidatedAt) -> PRESERVE for audit/replay
  for (let i = 0; i < 20; i++) {
    seed.push({
      table: sessionTable('user-1'),
      id: `inval-recent-${i}`,
      record: {
        userId: 'user-1',
        createdAt: new Date(nowTime - 2 * 3600000).toISOString(),
        lastActiveAt: new Date(nowTime - 45 * 60000).toISOString(),
        invalidatedAt: new Date(nowTime - 30 * 60000).toISOString(),
        reason: 'user_signout'
      }
    });
  }

  // 4. 30 stale invalidated sessions (>1h since invalidatedAt) -> DELETE (positioned beyond offset 100)
  for (let i = 0; i < 30; i++) {
    seed.push({
      table: sessionTable('user-1'),
      id: `inval-stale-${i}`,
      record: {
        userId: 'user-1',
        createdAt: new Date(nowTime - 5 * 3600000).toISOString(),
        lastActiveAt: new Date(nowTime - 4 * 3600000).toISOString(),
        invalidatedAt: new Date(nowTime - 2 * 3600000).toISOString(),
        reason: 'user_signout'
      }
    });
  }

  // Total records: 30 + 50 + 20 + 30 = 130 records (>125)
  assert.equal(seed.length, 130);
  const { database, store } = createMockDatabase(seed);

  await cleanupSessions(database, 'user-1', nowTime);

  const remaining = store.get(sessionTable('user-1'))!;
  // Preserved: 30 active + 20 recent invalidated = 50
  assert.equal(remaining.size, 50, 'Exactly 50 records should remain');
  for (let i = 0; i < 30; i++) assert.ok(remaining.has(`active-${i}`), `active-${i} must be preserved`);
  for (let i = 0; i < 20; i++) assert.ok(remaining.has(`inval-recent-${i}`), `inval-recent-${i} must be preserved`);
  for (let i = 0; i < 50; i++) assert.ok(!remaining.has(`expired-${i}`), `expired-${i} must be deleted`);
  for (let i = 0; i < 30; i++) assert.ok(!remaining.has(`inval-stale-${i}`), `inval-stale-${i} must be deleted`);
});

test('G. PAGINATED SIGN OUT EVERYWHERE: invalidates all 75+ active sessions across page boundaries', async () => {
  const baseTime = new Date('2026-09-05T12:00:00.000Z').getTime();
  const seed: Array<{ table: string; id: string; record: Record<string, unknown> }> = [];

  // 80 active sessions for user-1 (>75)
  for (let i = 0; i < 80; i++) {
    seed.push({
      table: sessionTable('user-1'),
      id: `u1-sess-${i}`,
      record: { userId: 'user-1', createdAt: new Date(baseTime).toISOString(), lastActiveAt: new Date(baseTime).toISOString() }
    });
  }

  // 10 active sessions for user-2 (tenant isolation check)
  for (let i = 0; i < 10; i++) {
    seed.push({
      table: sessionTable('user-2'),
      id: `u2-sess-${i}`,
      record: { userId: 'user-2', createdAt: new Date(baseTime).toISOString(), lastActiveAt: new Date(baseTime).toISOString() }
    });
  }

  const { database, store } = createMockDatabase(seed);

  const result = await invalidateSession(database, 'user-1', undefined, true, '2026-09-05T12:30:00.000Z');
  assert.equal(result.ok, true);
  assert.equal(result.invalidatedCount, 80);

  // Verify all 80 user-1 sessions are invalidated
  const u1Table = store.get(sessionTable('user-1'))!;
  for (let i = 0; i < 80; i++) {
    const s = u1Table.get(`u1-sess-${i}`) as UserSession;
    assert.ok(s.invalidatedAt, `u1-sess-${i} must be invalidated`);
    assert.equal(s.reason, 'user_signout');
  }

  // Verify user-2 sessions were completely untouched
  const u2Table = store.get(sessionTable('user-2'))!;
  for (let i = 0; i < 10; i++) {
    const s = u2Table.get(`u2-sess-${i}`) as UserSession;
    assert.equal(s.invalidatedAt, undefined, `user-2 session u2-sess-${i} must remain active`);
  }
});

test('H. SAFE SINGLE-SESSION INVALIDATION: missing sessionId does not invalidate all sessions', async () => {
  const baseTime = new Date('2026-09-05T12:00:00.000Z').getTime();
  const seed: Array<{ table: string; id: string; record: Record<string, unknown> }> = [
    { table: sessionTable('user-1'), id: 'dev-1', record: { userId: 'user-1', createdAt: new Date(baseTime).toISOString(), lastActiveAt: new Date(baseTime).toISOString() } },
    { table: sessionTable('user-1'), id: 'dev-2', record: { userId: 'user-1', createdAt: new Date(baseTime).toISOString(), lastActiveAt: new Date(baseTime).toISOString() } }
  ];

  const { database, store } = createMockDatabase(seed);

  // Call invalidate without sessionId and without everywhere: true
  const res = await invalidateSession(database, 'user-1', undefined, false, '2026-09-05T12:30:00.000Z');
  assert.equal(res.ok, false);
  assert.equal(res.error, 'session_id_required');

  // Verify NEITHER session was invalidated
  const u1Table = store.get(sessionTable('user-1'))!;
  const d1 = u1Table.get('dev-1') as UserSession;
  const d2 = u1Table.get('dev-2') as UserSession;
  assert.equal(d1.invalidatedAt, undefined, 'dev-1 must remain active');
  assert.equal(d2.invalidatedAt, undefined, 'dev-2 must remain active');
});

test('I. SIGN OUT EVERYWHERE: everywhere=true invalidates only authenticated tenant sessions', async () => {
  const baseTime = new Date('2026-09-05T12:00:00.000Z').getTime();
  const { database, store } = createMockDatabase([
    { table: sessionTable('user-1'), id: 'sess-1', record: { userId: 'user-1', createdAt: new Date(baseTime).toISOString(), lastActiveAt: new Date(baseTime).toISOString() } },
    { table: sessionTable('user-1'), id: 'sess-2', record: { userId: 'user-1', createdAt: new Date(baseTime).toISOString(), lastActiveAt: new Date(baseTime).toISOString() } },
    { table: sessionTable('user-2'), id: 'sess-other', record: { userId: 'user-2', createdAt: new Date(baseTime).toISOString(), lastActiveAt: new Date(baseTime).toISOString() } }
  ]);

  const res = await invalidateSession(database, 'user-1', undefined, true, '2026-09-05T12:15:00.000Z');
  assert.equal(res.ok, true);

  const s1 = store.get(sessionTable('user-1'))!.get('sess-1') as UserSession;
  const s2 = store.get(sessionTable('user-1'))!.get('sess-2') as UserSession;
  const sOther = store.get(sessionTable('user-2'))!.get('sess-other') as UserSession;

  assert.ok(s1.invalidatedAt, 'user-1 sess-1 must be invalidated');
  assert.ok(s2.invalidatedAt, 'user-1 sess-2 must be invalidated');
  assert.equal(sOther.invalidatedAt, undefined, 'user-2 sess-other must remain untouched');
});

test('J. REVIVAL PREVENTION: invalidated session cannot revive itself', async () => {
  const baseTime = new Date('2026-09-05T12:00:00.000Z').getTime();
  const { database, store } = createMockDatabase([
    { table: sessionTable('user-1'), id: 'inval-target', record: { userId: 'user-1', createdAt: new Date(baseTime).toISOString(), lastActiveAt: new Date(baseTime).toISOString(), invalidatedAt: new Date(baseTime + 1000).toISOString() } }
  ]);

  const res = await evaluateSession(database, 'user-1', 'inval-target', { touchActivity: true }, baseTime + 5000);
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.status, 401);
    assert.equal(res.code, 'session_expired');
  }

  const stored = store.get(sessionTable('user-1'))!.get('inval-target') as UserSession;
  assert.ok(stored.invalidatedAt, 'session must remain invalidated');
});

test('K. IDLE TIMEOUT: >30m inactive returns 401 session_idle_timeout and marks invalidated', async () => {
  const nowTime = new Date('2026-09-05T12:00:00.000Z').getTime();
  const createdStr = new Date(nowTime - 40 * 60 * 1000).toISOString();
  const lastActiveStr = new Date(nowTime - 31 * 60 * 1000).toISOString();

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

  const stored = store.get(sessionTable('user-1'))!.get('s-idle') as UserSession;
  assert.ok(stored.invalidatedAt, 'session must be marked invalidated in database');
  assert.equal(stored.reason, 'idle_timeout');
});

test('L. ABSOLUTE TIMEOUT: >12h old returns 401 session_absolute_timeout even if recently active', async () => {
  const nowTime = new Date('2026-09-05T13:00:00.000Z').getTime();
  const createdStr = new Date(nowTime - (12 * 60 * 60 * 1000 + 60000)).toISOString();
  const recentActiveStr = new Date(nowTime - 2 * 60 * 1000).toISOString();

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

  const stored = store.get(sessionTable('user-1'))!.get('s-abs') as UserSession;
  assert.ok(stored.invalidatedAt, 'session must be marked invalidated upon absolute timeout');
  assert.equal(stored.reason, 'absolute_timeout');
});

test('M. SENSITIVE PRE-REQUEST ACTIVITY ORDERING: stale sensitive request cannot make itself recent', async () => {
  const baseTime = new Date('2026-09-05T12:00:00.000Z').getTime();
  const preRequestActive = new Date(baseTime - 16 * 60 * 1000).toISOString(); // 16m ago (>15m, <30m)

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

test('N. URL QUERY PARAMETER SESSION IDS REJECTED: header transport authoritative', () => {
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

  // 4. JSON Body disallowed by default on normal protected routes
  const reqBodyNormal = { body: { sessionId: 'body-sid-456' } };
  assert.equal(getSessionId(reqBodyNormal), undefined, 'body.sessionId must be ignored on normal protected routes');

  // 5. JSON Body allowed when explicitly permitted for lifecycle action (invalidate)
  assert.equal(getSessionId(reqBodyNormal, { allowBody: true }), 'body-sid-456');
});
