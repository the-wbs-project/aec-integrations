/**
 * The pure half of vendor seat invites (AECI-664 / §11a) — the redeem rules and
 * the batch shapes, asserted with no D1 and no HTTP.
 *
 * `inviteRedeemState` gets the most attention here because it is the security
 * boundary: it is the ONLY thing standing between "holds a link" and "holds a
 * seat", and it is shared by the preview read and the accept write, so a
 * regression here is simultaneously a wrong answer on screen and a wrong write.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { makeTestDb, type TestDb } from '../test/d1';
import {
  acceptInviteStatements,
  createInviteStatements,
  inviteExpiryFrom,
  inviteRedeemState,
  normalizeInviteEmail,
  revokeInviteStatements,
  INVITE_TTL_DAYS,
  type RedeemableInvite,
} from './vendor-seat-invites';

const NOW = '2026-08-26T12:00:00.000Z';
const VENDOR = '00000000-0000-4000-8000-000000000001';
const INVITE = '00000000-0000-4000-8000-000000000002';
const USER = '00000000-0000-4000-8000-000000000003';
const ACTOR = '00000000-0000-4000-8000-000000000004';

const live: RedeemableInvite = {
  email: 'dana@acme.com',
  expiresAt: '2026-09-09T12:00:00.000Z',
  acceptedAt: null,
  revokedAt: null,
};

describe('inviteRedeemState', () => {
  it('redeems for the invited address', () => {
    expect(inviteRedeemState(live, NOW, 'dana@acme.com')).toBe('ok');
  });

  it('is case- and whitespace-insensitive on both sides', () => {
    // GoTrue stores lowercase but a JWT claim is whatever was typed at signup,
    // and the invited address is whatever the owner typed. Neither side can be
    // assumed normalized, so both are normalized here.
    expect(inviteRedeemState({ ...live, email: 'Dana@Acme.com' }, NOW, '  DANA@acme.COM ')).toBe(
      'ok',
    );
  });

  it('refuses a different address — the whole security control', () => {
    expect(inviteRedeemState(live, NOW, 'someone.else@acme.com')).toBe('email_mismatch');
  });

  it('FAILS CLOSED when the session carries no email', () => {
    // `AuthenticatedSession.email` is optional (it comes off the JWT). A redeem we
    // cannot bind to an address must be refused, never waved through — this is the
    // case where a bug would turn the token back into a bearer credential.
    expect(inviteRedeemState(live, NOW, undefined)).toBe('email_mismatch');
    expect(inviteRedeemState(live, NOW, '')).toBe('email_mismatch');
  });

  it('reports the terminal states ahead of the address check', () => {
    // Order matters: a spent invite must say WHY it is spent rather than blaming
    // whoever happens to be signed in.
    const wrong = 'someone.else@acme.com';
    expect(inviteRedeemState({ ...live, revokedAt: NOW }, NOW, wrong)).toBe('revoked');
    expect(inviteRedeemState({ ...live, acceptedAt: NOW }, NOW, wrong)).toBe('accepted');
  });

  it('revoked beats accepted', () => {
    expect(inviteRedeemState({ ...live, revokedAt: NOW, acceptedAt: NOW }, NOW, live.email)).toBe(
      'revoked',
    );
  });

  it('expires on the boundary, not after it', () => {
    const at = { ...live, expiresAt: NOW };
    expect(inviteRedeemState(at, NOW, live.email)).toBe('expired');
    expect(
      inviteRedeemState({ ...live, expiresAt: '2026-08-26T12:00:00.001Z' }, NOW, live.email),
    ).toBe('ok');
  });
});

describe('normalizeInviteEmail / inviteExpiryFrom', () => {
  it('lowercases and trims', () => {
    expect(normalizeInviteEmail('  Dana@ACME.com ')).toBe('dana@acme.com');
  });

  it('expires INVITE_TTL_DAYS after now', () => {
    const out = inviteExpiryFrom(NOW);
    expect(Date.parse(out) - Date.parse(NOW)).toBe(INVITE_TTL_DAYS * 86_400_000);
  });
});

describe('batch shapes', () => {
  let t: TestDb;
  beforeEach(async () => {
    t = await makeTestDb();
  });
  afterEach(() => t.dispose());

  const sqlOf = (stmts: ReturnType<typeof createInviteStatements>['stmts']) =>
    stmts.map((s) => (s as unknown as { toSQL(): { sql: string } }).toSQL().sql);

  it('create: one insert + its audit row, in the SAME batch (§26.1)', () => {
    const batch = createInviteStatements(t.db, {
      inviteId: INVITE,
      token: 'tok',
      vendorId: VENDOR,
      email: 'dana@acme.com',
      actorId: ACTOR,
      actorType: 'user',
      now: NOW,
      expiresAt: '2026-09-09T12:00:00.000Z',
    });
    const sql = sqlOf(batch.stmts);
    expect(sql).toHaveLength(2);
    expect(sql[0]).toContain('vendor_seat_invites');
    expect(sql[1]).toContain('audit_log');
    expect(batch.auditEntry.action).toBe('vendor_seat.invited');
  });

  it('create: the TOKEN never reaches the audit row', () => {
    // Audit rows are admin-readable and forwarded to PostHog Logs (§26.5). A
    // redeem handle in either is a credential in a log.
    const batch = createInviteStatements(t.db, {
      inviteId: INVITE,
      token: 'super-secret-token',
      vendorId: VENDOR,
      email: 'dana@acme.com',
      actorId: ACTOR,
      actorType: 'user',
      now: NOW,
      expiresAt: '2026-09-09T12:00:00.000Z',
    });
    expect(JSON.stringify(batch.auditEntry)).not.toContain('super-secret-token');
  });

  it('revoke: guards on still-pending so a double-revoke is a no-op', () => {
    const batch = revokeInviteStatements(t.db, {
      inviteId: INVITE,
      vendorId: VENDOR,
      email: 'dana@acme.com',
      actorId: ACTOR,
      actorType: 'user',
      now: NOW,
    });
    const [update] = sqlOf(batch.stmts);
    expect(update).toContain('"accepted_at" is null');
    expect(update).toContain('"revoked_at" is null');
    expect(update).toContain('"vendor_id" = ?');
    expect(batch.auditEntry.action).toBe('vendor_seat.invite_revoked');
  });

  it('accept: seat is NOT an owner, and an on-domain redeem sets work_email_verified', () => {
    const batch = acceptInviteStatements(t.db, {
      inviteId: INVITE,
      vendorId: VENDOR,
      email: 'dana@acme.com',
      userId: USER,
      actorType: 'user',
      now: NOW,
      domainMatched: true,
      profileBefore: null,
    });
    const [upsert, spend, audit] = sqlOf(batch.stmts);
    // An invited seat that could invite would let one AECi-reviewed human seed an
    // unbounded chain of seats no reviewer ever saw.
    expect(batch.auditEntry.afterState).toMatchObject({
      seat_owner: false,
      work_email_verified: true,
    });
    expect(upsert).toContain('profiles');
    expect(upsert).toContain('on conflict');
    // Single-use: two concurrent redeems must produce one seat, not two.
    expect(spend).toContain('"accepted_at" is null');
    expect(audit).toContain('audit_log');
    expect(batch.auditEntry.action).toBe('vendor_seat.invite_accepted');
  });

  it('accept: never touches vendors or vendor_entitlements (§8.3(2))', () => {
    const batch = acceptInviteStatements(t.db, {
      inviteId: INVITE,
      vendorId: VENDOR,
      email: 'dana@acme.com',
      userId: USER,
      actorType: 'user',
      now: NOW,
      domainMatched: true,
      profileBefore: {
        role: 'reviewer',
        vendorId: null,
        seatOwner: false,
        workEmailVerified: false,
      },
    });
    for (const sql of sqlOf(batch.stmts)) {
      expect(sql).not.toContain('update "vendors"');
      expect(sql).not.toContain('vendor_entitlements');
    }
  });

  it('accept: an OFF-DOMAIN redeem leaves work_email_verified false', () => {
    // Since §11a.3 removed the invite-time domain gate, "they redeemed" no longer
    // implies "they work there". The column is read by a human on the §5 claim
    // queue, so it tracks the address, not the redeem.
    const batch = acceptInviteStatements(t.db, {
      inviteId: INVITE,
      vendorId: VENDOR,
      email: 'dana@gmail.com',
      userId: USER,
      actorType: 'user',
      now: NOW,
      domainMatched: false,
      profileBefore: null,
    });
    expect(batch.auditEntry.afterState).toMatchObject({ work_email_verified: false });
  });

  it('accept: an off-domain redeem never CLEARS an earned work_email_verified', () => {
    const batch = acceptInviteStatements(t.db, {
      inviteId: INVITE,
      vendorId: VENDOR,
      email: 'dana@gmail.com',
      userId: USER,
      actorType: 'user',
      now: NOW,
      domainMatched: false,
      profileBefore: {
        role: 'vendor_admin',
        vendorId: VENDOR,
        seatOwner: false,
        workEmailVerified: true,
      },
    });
    expect(batch.auditEntry.afterState).toMatchObject({ work_email_verified: true });
  });

  it('accept: redeeming NEVER demotes an existing owner (last-owner safety)', () => {
    // An existing owner who redeems an invite (re-invited or self-invited) must
    // keep their bit — forcing it false could strip the only owner and leave the
    // vendor unadministrable, the state the removal path's last-owner guard exists
    // to prevent.
    const batch = acceptInviteStatements(t.db, {
      inviteId: INVITE,
      vendorId: VENDOR,
      email: 'dana@acme.com',
      userId: USER,
      actorType: 'user',
      now: NOW,
      domainMatched: true,
      profileBefore: {
        role: 'vendor_admin',
        vendorId: VENDOR,
        seatOwner: true,
        workEmailVerified: true,
      },
    });
    const [upsert] = sqlOf(batch.stmts);
    expect(batch.auditEntry.afterState).toMatchObject({ seat_owner: true });
    // The conflict path preserves the owner bit rather than forcing it false.
    expect(upsert).toContain('on conflict');
  });
});
