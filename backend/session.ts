export type UserSession = {
  id?: string;
  userId: string;
  createdAt: string;
  lastActiveAt: string;
  invalidatedAt?: string;
  reason?: 'user_signout' | 'idle_timeout' | 'absolute_timeout' | 'superseded' | 'recent_activity_required';
};

export type SessionDatabase = {
  add(table: string, records: Array<Record<string, unknown>>): Promise<Array<string | null>>;
  update(table: string, items: Array<{ id: string; record: Record<string, unknown> }>): Promise<boolean[]>;
  list<T = Record<string, unknown>>(table: string, options?: { limit?: number; nextToken?: string }): Promise<{ items: Array<T & { id: string }>; nextToken?: string }>;
  get<T = Record<string, unknown>>(table: string, ids: string[]): Promise<Array<(T & { id: string }) | null>>;
  delete(table: string, ids: string[]): Promise<boolean[]>;
};

export const SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
export const SESSION_ABSOLUTE_LIFETIME_MS = 12 * 60 * 60 * 1000;
export const SENSITIVE_ACTION_MAX_AGE_MS = 15 * 60 * 1000;
export const INVALIDATED_SESSION_RETENTION_MS = 60 * 60 * 1000;

export const sessionTable = (userId: string) => `sessions:${userId}`;

export type IncomingRequestLike = {
  body?: unknown;
  query?: Record<string, string>;
  event?: unknown;
  headers?: Record<string, string>;
};

export const getSessionId = (req: IncomingRequestLike, opts: { allowBody?: boolean } = {}): string | undefined => {
  // Session IDs must NEVER be accepted from URL query parameters (req.query).
  const rawHeaders = req.headers || (req.event as { headers?: Record<string, string> } | undefined)?.headers;
  if (rawHeaders) {
    for (const key of Object.keys(rawHeaders)) {
      if (key.toLowerCase() === 'x-session-id') {
        const val = rawHeaders[key];
        if (typeof val === 'string' && val.trim()) return val.trim();
      }
    }
  }
  // Restrict body.sessionId to explicit session-lifecycle operations (e.g. invalidate)
  if (opts.allowBody) {
    const body = req.body as { sessionId?: string } | undefined;
    if (typeof body?.sessionId === 'string' && body.sessionId.trim()) {
      return body.sessionId.trim();
    }
  }
  return undefined;
};

export const resolveSession = async (
  database: SessionDatabase,
  userId: string,
  sessionId?: string
): Promise<(UserSession & { id: string }) | null> => {
  // Exact session ID is required; NO single-active-session fallback.
  if (!sessionId || !sessionId.trim()) {
    return null;
  }
  const [s] = await database.get<UserSession>(sessionTable(userId), [sessionId.trim()]);
  if (s && s.userId === userId) {
    return { ...s, id: sessionId.trim() };
  }
  return null;
};

export const cleanupSessions = async (
  database: SessionDatabase,
  userId: string,
  now: number = Date.now(),
  maxBatches: number = 50
) => {
  const table = sessionTable(userId);
  let nextToken: string | undefined;
  let batchCount = 0;
  const toDelete: string[] = [];

  do {
    const page = await database.list<UserSession>(table, { limit: 100, nextToken });
    batchCount++;
    for (const r of page.items || []) {
      const created = new Date(r.createdAt).getTime();
      const isPastAbsolute = !isNaN(created) && now - created > SESSION_ABSOLUTE_LIFETIME_MS;
      if (r.invalidatedAt) {
        const inval = new Date(r.invalidatedAt).getTime();
        if (!isNaN(inval) && now - inval > INVALIDATED_SESSION_RETENTION_MS) {
          toDelete.push(r.id);
        }
      } else if (isPastAbsolute) {
        toDelete.push(r.id);
      }
    }
    nextToken = page.nextToken;
  } while (nextToken && batchCount < maxBatches);

  if (toDelete.length) {
    for (let i = 0; i < toDelete.length; i += 100) {
      await database.delete(table, toDelete.slice(i, i + 100));
    }
  }
};

export type SessionEnforcementResult =
  | { ok: true; session: UserSession & { id: string } }
  | { ok: false; status: 401 | 403; code: 'Unauthorized' | 'session_expired' | 'session_idle_timeout' | 'session_absolute_timeout' | 'recent_activity_required' };

export const evaluateSession = async (
  database: SessionDatabase,
  userId: string | undefined,
  sessionId: string | undefined,
  opts: { touchActivity?: boolean; sensitive?: boolean } = {},
  now: number = Date.now()
): Promise<SessionEnforcementResult> => {
  // 1. Authenticate user
  if (!userId) {
    return { ok: false, status: 401, code: 'Unauthorized' };
  }

  // 2. Require exact session ID
  if (!sessionId || !sessionId.trim()) {
    return { ok: false, status: 401, code: 'session_expired' };
  }

  // 3. Locate exact session (no single-session fallback)
  const session = await resolveSession(database, userId, sessionId);

  // 4. Reject nonexistent or invalidated session
  if (!session || session.invalidatedAt) {
    return { ok: false, status: 401, code: 'session_expired' };
  }

  const lastActiveTime = new Date(session.lastActiveAt).getTime();
  const createdTime = new Date(session.createdAt).getTime();

  // 5. Enforce absolute lifetime
  if (now - createdTime > SESSION_ABSOLUTE_LIFETIME_MS) {
    await database.update(sessionTable(userId), [{
      id: session.id,
      record: { ...session, invalidatedAt: new Date(now).toISOString(), reason: 'absolute_timeout' }
    }]);
    return { ok: false, status: 401, code: 'session_absolute_timeout' };
  }

  // 6. Enforce idle lifetime
  if (now - lastActiveTime > SESSION_IDLE_TIMEOUT_MS) {
    await database.update(sessionTable(userId), [{
      id: session.id,
      record: { ...session, invalidatedAt: new Date(now).toISOString(), reason: 'idle_timeout' }
    }]);
    return { ok: false, status: 401, code: 'session_idle_timeout' };
  }

  // 7. Enforce sensitive/recent-activity requirement using pre-request existing timestamps
  if (opts.sensitive) {
    if (now - lastActiveTime > SENSITIVE_ACTION_MAX_AGE_MS || now - createdTime > SENSITIVE_ACTION_MAX_AGE_MS) {
      return { ok: false, status: 403, code: 'recent_activity_required' };
    }
  }

  // 8. Only after all checks pass, update lastActiveAt when touchActivity=true
  if (opts.touchActivity) {
    await database.update(sessionTable(userId), [{
      id: session.id,
      record: { ...session, lastActiveAt: new Date(now).toISOString() }
    }]);
    session.lastActiveAt = new Date(now).toISOString();
  }

  return { ok: true, session };
};

export const initSession = async (database: SessionDatabase, userId: string, now: string = new Date().toISOString()) => {
  await cleanupSessions(database, userId, new Date(now).getTime());
  const [id] = await database.add(sessionTable(userId), [{ userId, createdAt: now, lastActiveAt: now }]);
  return {
    sessionId: id,
    createdAt: now,
    lastActiveAt: now,
    idleTimeoutMs: SESSION_IDLE_TIMEOUT_MS,
    absoluteLifetimeMs: SESSION_ABSOLUTE_LIFETIME_MS
  };
};

export type InvalidateSessionResult = {
  ok: boolean;
  invalidatedCount?: number;
  error?: string;
};

export const invalidateSession = async (
  database: SessionDatabase,
  userId: string,
  sessionId?: string,
  everywhere?: boolean,
  now: string = new Date().toISOString(),
  maxBatches: number = 50
): Promise<InvalidateSessionResult> => {
  const table = sessionTable(userId);

  // Sign out everywhere must require explicit everywhere: true
  if (everywhere === true) {
    let nextToken: string | undefined;
    let batchCount = 0;
    let totalInvalidated = 0;

    do {
      const page = await database.list<UserSession>(table, { limit: 100, nextToken });
      batchCount++;
      const active = (page.items || []).filter(s => !s.invalidatedAt);
      if (active.length) {
        await database.update(
          table,
          active.map(s => ({ id: s.id, record: { ...s, invalidatedAt: now, reason: 'user_signout' } }))
        );
        totalInvalidated += active.length;
      }
      nextToken = page.nextToken;
    } while (nextToken && batchCount < maxBatches);

    return { ok: true, invalidatedCount: totalInvalidated };
  }

  // Normal single-session sign-out: sessionId is required!
  if (!sessionId || !sessionId.trim()) {
    // Missing sessionId must NOT invalidate all sessions
    return { ok: false, error: 'session_id_required' };
  }

  const [target] = await database.get<UserSession>(table, [sessionId.trim()]);
  if (!target || target.userId !== userId) {
    return { ok: false, error: 'session_not_found' };
  }

  if (!target.invalidatedAt) {
    await database.update(table, [{
      id: sessionId.trim(),
      record: { ...target, invalidatedAt: now, reason: 'user_signout' }
    }]);
  }
  return { ok: true, invalidatedCount: 1 };
};
