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

export const sessionTable = (userId: string) => `sessions:${userId}`;

export type IncomingRequestLike = {
  body?: unknown;
  query?: Record<string, string>;
  event?: unknown;
  headers?: Record<string, string>;
};

export const getSessionId = (req: IncomingRequestLike): string | undefined => {
  // Session IDs must NEVER be accepted from URL query parameters (req.query).
  const body = req.body as { sessionId?: string } | undefined;
  if (typeof body?.sessionId === 'string' && body.sessionId.trim()) {
    return body.sessionId.trim();
  }
  const rawHeaders = req.headers || (req.event as { headers?: Record<string, string> } | undefined)?.headers;
  if (rawHeaders) {
    for (const key of Object.keys(rawHeaders)) {
      if (key.toLowerCase() === 'x-session-id') {
        const val = rawHeaders[key];
        if (typeof val === 'string' && val.trim()) return val.trim();
      }
    }
  }
  return undefined;
};

export const resolveSession = async (
  database: SessionDatabase,
  userId: string,
  sessionId?: string
): Promise<(UserSession & { id: string }) | null> => {
  if (sessionId) {
    const [s] = await database.get<UserSession>(sessionTable(userId), [sessionId]);
    if (s && s.userId === userId) return { ...s, id: sessionId };
    return null;
  }
  const active = (await database.list<UserSession>(sessionTable(userId), { limit: 20 })).items.filter(s => !s.invalidatedAt);
  if (active.length === 1) return active[0];
  return null;
};

export const cleanupSessions = async (database: SessionDatabase, userId: string, now: number = Date.now()) => {
  const records = (await database.list<UserSession>(sessionTable(userId), { limit: 50 })).items;
  const toDelete: string[] = [];
  for (const r of records) {
    const created = new Date(r.createdAt).getTime();
    const isPastAbsolute = !isNaN(created) && now - created > SESSION_ABSOLUTE_LIFETIME_MS;
    if (r.invalidatedAt) {
      const inval = new Date(r.invalidatedAt).getTime();
      if (!isNaN(inval) && now - inval > 3600000) toDelete.push(r.id);
    } else if (isPastAbsolute) {
      toDelete.push(r.id);
    }
  }
  if (toDelete.length) await database.delete(sessionTable(userId), toDelete);
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

  // 2. Locate exact session
  const session = await resolveSession(database, userId, sessionId);

  // 3. Reject invalidated session
  if (!session || session.invalidatedAt) {
    return { ok: false, status: 401, code: 'session_expired' };
  }

  const lastActiveTime = new Date(session.lastActiveAt).getTime();
  const createdTime = new Date(session.createdAt).getTime();

  // 4. Enforce absolute lifetime
  if (now - createdTime > SESSION_ABSOLUTE_LIFETIME_MS) {
    await database.update(sessionTable(userId), [{
      id: session.id,
      record: { ...session, invalidatedAt: new Date(now).toISOString(), reason: 'absolute_timeout' }
    }]);
    return { ok: false, status: 401, code: 'session_absolute_timeout' };
  }

  // 5. Enforce idle lifetime
  if (now - lastActiveTime > SESSION_IDLE_TIMEOUT_MS) {
    await database.update(sessionTable(userId), [{
      id: session.id,
      record: { ...session, invalidatedAt: new Date(now).toISOString(), reason: 'idle_timeout' }
    }]);
    return { ok: false, status: 401, code: 'session_idle_timeout' };
  }

  // 6. Enforce sensitive/recent-activity requirement using pre-request existing timestamps
  if (opts.sensitive) {
    if (now - lastActiveTime > SENSITIVE_ACTION_MAX_AGE_MS || now - createdTime > SENSITIVE_ACTION_MAX_AGE_MS) {
      return { ok: false, status: 403, code: 'recent_activity_required' };
    }
  }

  // 7. Only after all checks pass, update lastActiveAt when touchActivity=true
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

export const invalidateSession = async (
  database: SessionDatabase,
  userId: string,
  sessionId?: string,
  everywhere?: boolean,
  now: string = new Date().toISOString()
) => {
  if (everywhere || !sessionId) {
    const active = (await database.list<UserSession>(sessionTable(userId), { limit: 20 })).items.filter(s => !s.invalidatedAt);
    if (active.length) {
      await database.update(
        sessionTable(userId),
        active.map(s => ({ id: s.id, record: { ...s, invalidatedAt: now, reason: 'user_signout' } }))
      );
    }
  } else {
    const [target] = await database.get<UserSession>(sessionTable(userId), [sessionId]);
    if (target && target.userId === userId) {
      await database.update(sessionTable(userId), [{ id: sessionId, record: { ...target, invalidatedAt: now, reason: 'user_signout' } }]);
    }
  }
};
