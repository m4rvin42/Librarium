import crypto from 'node:crypto';
import { ApiCredentialInput, ApiCredentialScopeType, apiCredentialScopes } from '@librarium/shared';
import { db, id, now } from './db.js';

export type AssistantIdentity = {
  id: string;
  name: string;
  scopes: ApiCredentialScopeType[];
  legacy?: boolean;
};

const digest = (value: string) => crypto.createHash('sha256').update(value).digest('hex');

export function createCredential(input: unknown) {
  const value = ApiCredentialInput.parse(input);
  const credentialId = id();
  const secret = crypto.randomBytes(32).toString('base64url');
  const prefix = crypto.randomBytes(5).toString('hex');
  const token = `lib_${prefix}_${secret}`;
  db.prepare(
    'INSERT INTO api_credentials(id,name,token_hash,token_prefix,scopes,expires_at,created_at) VALUES(?,?,?,?,?,?,?)',
  ).run(
    credentialId,
    value.name,
    digest(token),
    `lib_${prefix}`,
    JSON.stringify(value.scopes),
    value.expiresAt ?? null,
    now(),
  );
  return { ...credentialRecord(credentialId), token };
}

function mapCredential(row: any) {
  return {
    id: row.id,
    name: row.name,
    tokenPrefix: row.token_prefix,
    scopes: JSON.parse(row.scopes) as ApiCredentialScopeType[],
    expiresAt: row.expires_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
  };
}

export function credentialRecord(credentialId: string) {
  const row = db.prepare('SELECT * FROM api_credentials WHERE id=?').get(credentialId);
  return row ? mapCredential(row) : null;
}

export function listCredentials() {
  return (db.prepare('SELECT * FROM api_credentials ORDER BY created_at DESC').all() as any[]).map(
    mapCredential,
  );
}

export function revokeCredential(credentialId: string) {
  return (
    db
      .prepare('UPDATE api_credentials SET revoked_at=? WHERE id=? AND revoked_at IS NULL')
      .run(now(), credentialId).changes > 0
  );
}

export function authenticateCredential(token: string): AssistantIdentity | null {
  const row = db
    .prepare(
      'SELECT * FROM api_credentials WHERE token_hash=? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>?)',
    )
    .get(digest(token), now()) as any;
  if (!row) return null;
  db.prepare('UPDATE api_credentials SET last_used_at=? WHERE id=?').run(now(), row.id);
  return { id: row.id, name: row.name, scopes: JSON.parse(row.scopes) };
}

export function hasScope(identity: AssistantIdentity | undefined, scope: ApiCredentialScopeType) {
  return Boolean(identity?.legacy || identity?.scopes.includes(scope));
}

export function requireScope(
  identity: AssistantIdentity | undefined,
  scope: ApiCredentialScopeType,
) {
  if (!hasScope(identity, scope)) {
    const cause = new Error(`Credential requires the ${scope} scope`) as Error & {
      statusCode: number;
      code: string;
    };
    cause.statusCode = 403;
    cause.code = 'INSUFFICIENT_SCOPE';
    throw cause;
  }
}

export function audit(
  identity: AssistantIdentity | undefined,
  operation: string,
  statusCode: number,
  targetType?: string,
  targetId?: string,
) {
  db.prepare(
    'INSERT INTO audit_events(id,credential_id,actor_type,operation,target_type,target_id,status_code,created_at) VALUES(?,?,?,?,?,?,?,?)',
  ).run(
    id(),
    identity?.legacy ? null : (identity?.id ?? null),
    identity ? (identity.legacy ? 'legacy_token' : 'credential') : 'session',
    operation,
    targetType ?? null,
    targetId ?? null,
    statusCode,
    now(),
  );
}

export function listAuditEvents(page = 1, limit = 50) {
  const safePage = Math.max(1, page);
  const safeLimit = Math.min(100, Math.max(1, limit));
  const total = (db.prepare('SELECT count(*) count FROM audit_events').get() as any).count;
  const items = db
    .prepare(
      `SELECT e.id,e.actor_type actorType,e.operation,e.target_type targetType,
        e.target_id targetId,e.status_code statusCode,e.created_at createdAt,
        c.name credentialName,c.token_prefix credentialPrefix
       FROM audit_events e LEFT JOIN api_credentials c ON c.id=e.credential_id
       ORDER BY e.created_at DESC LIMIT ? OFFSET ?`,
    )
    .all(safeLimit, (safePage - 1) * safeLimit);
  return { items, page: safePage, limit: safeLimit, total };
}

export const allCredentialScopes = [...apiCredentialScopes];

export function requestDigest(value: unknown) {
  return digest(JSON.stringify(value ?? null));
}

export function findIdempotentResponse(
  credentialId: string,
  key: string,
  method: string,
  path: string,
) {
  return db
    .prepare(
      'SELECT request_hash,response_status,response_body FROM idempotency_records WHERE credential_id=? AND key=? AND method=? AND path=?',
    )
    .get(credentialId, key, method, path) as
    { request_hash: string; response_status: number; response_body: string } | undefined;
}

export function saveIdempotentResponse(input: {
  credentialId: string;
  key: string;
  method: string;
  path: string;
  requestHash: string;
  status: number;
  body: string;
}) {
  db.prepare(
    `INSERT OR IGNORE INTO idempotency_records(
      credential_id,key,method,path,request_hash,response_status,response_body,created_at
    ) VALUES(?,?,?,?,?,?,?,?)`,
  ).run(
    input.credentialId,
    input.key,
    input.method,
    input.path,
    input.requestHash,
    input.status,
    input.body,
    now(),
  );
  db.prepare("DELETE FROM idempotency_records WHERE created_at<datetime('now','-1 day')").run();
}
