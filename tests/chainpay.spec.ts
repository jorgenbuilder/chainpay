import { describe, beforeAll, afterAll, it, expect, inject } from 'vitest';
import { PocketIc, type Actor } from '@dfinity/pic';
import { Principal } from '@dfinity/principal';
import { resolve } from 'path';

import type { _SERVICE, CreateLinkArgs, PaymentLinkInfo } from './declarations/declarations/backend.did.d.ts';
const { idlFactory } = await import('./declarations/declarations/backend.did.js');

const WASM_PATH = resolve(
  import.meta.dirname,
  '..',
  '.icp',
  'cache',
  'artifacts',
  'backend',
);

// Test principals
const ALICE = Principal.fromText('rwlgt-iiaaa-aaaaa-aaaaa-cai');
const BOB = Principal.fromText('rrkah-fqaaa-aaaaa-aaaaq-cai');
const EVE = Principal.fromText('ryjl3-tyaaa-aaaaa-aaaba-cai');

describe('ChainPay Backend', () => {
  let pic: PocketIc;
  let canisterId: Principal;

  let aliceActor: Actor<_SERVICE>;
  let bobActor: Actor<_SERVICE>;
  let eveActor: Actor<_SERVICE>;
  let anonActor: Actor<_SERVICE>;

  beforeAll(async () => {
    pic = await PocketIc.create(inject('PIC_URL'), {
      application: [{ state: { type: 'new' as any } }],
    });

    const fixture = await pic.setupCanister<_SERVICE>({
      idlFactory,
      wasm: WASM_PATH,
      sender: ALICE,
    });

    canisterId = fixture.canisterId;
    aliceActor = fixture.actor;
    aliceActor.setPrincipal(ALICE);

    bobActor = pic.createActor<_SERVICE>(idlFactory, canisterId);
    bobActor.setPrincipal(BOB);

    eveActor = pic.createActor<_SERVICE>(idlFactory, canisterId);
    eveActor.setPrincipal(EVE);

    anonActor = pic.createActor<_SERVICE>(idlFactory, canisterId);
  });

  afterAll(async () => {
    await pic.tearDown();
  });

  // Helper to create a link
  async function createTestLink(
    actor: Actor<_SERVICE>,
    overrides: Partial<CreateLinkArgs> = {},
  ): Promise<string> {
    const args: CreateLinkArgs = {
      title: overrides.title ?? 'Test Payment',
      description: overrides.description ?? 'A test payment link',
      amount: overrides.amount ?? 100_000_000n, // 1 ICP
      method: overrides.method ?? { icp: null },
      expiresAt: overrides.expiresAt ?? [],
    };
    return actor.createLink(args);
  }

  // ---- Link Creation ----

  describe('Link creation', () => {
    it('should create a link and return an id', async () => {
      const id = await createTestLink(aliceActor);
      expect(id).toBe('0');
    });

    it('should create sequential link ids', async () => {
      const id1 = await createTestLink(aliceActor);
      const id2 = await createTestLink(aliceActor);
      expect(Number(id2)).toBeGreaterThan(Number(id1));
    });

    it('should reject anonymous callers', async () => {
      await expect(createTestLink(anonActor)).rejects.toThrow(
        /Anonymous callers not allowed/,
      );
    });

    it('should reject empty title', async () => {
      await expect(
        createTestLink(aliceActor, { title: '' }),
      ).rejects.toThrow(/Title must be 1-100 characters/);
    });

    it('should reject title > 100 chars', async () => {
      await expect(
        createTestLink(aliceActor, { title: 'a'.repeat(101) }),
      ).rejects.toThrow(/Title must be 1-100 characters/);
    });

    it('should reject description > 500 chars', async () => {
      await expect(
        createTestLink(aliceActor, { description: 'a'.repeat(501) }),
      ).rejects.toThrow(/Description must be <= 500 characters/);
    });

    it('should reject zero amount', async () => {
      await expect(
        createTestLink(aliceActor, { amount: 0n }),
      ).rejects.toThrow(/Amount must be greater than 0/);
    });

    it('should support ckBTC payment method', async () => {
      const id = await createTestLink(aliceActor, {
        title: 'BTC Payment',
        method: { ckbtc: null },
      });
      expect(id).toBeTruthy();
    });
  });

  // ---- Link Retrieval ----

  describe('Link retrieval', () => {
    it('should return link info for valid id', async () => {
      const id = await createTestLink(aliceActor, { title: 'Retrievable' });
      const info = await aliceActor.getLink(id);
      expect(info).toHaveLength(1);
      const link = info[0] as PaymentLinkInfo;
      expect(link.title).toBe('Retrievable');
      expect(link.amount).toBe(100_000_000n);
      expect(link.active).toBe(true);
      expect(link.totalReceived).toBe(0n);
      expect(link.paymentCount).toBe(0n);
    });

    it('should return empty for non-existent id', async () => {
      const info = await aliceActor.getLink('99999');
      expect(info).toHaveLength(0);
    });

    it('should be publicly accessible (no auth required)', async () => {
      const id = await createTestLink(aliceActor, { title: 'Public' });
      const info = await anonActor.getLink(id);
      expect(info).toHaveLength(1);
    });
  });

  // ---- Payment Address ----

  describe('Payment address', () => {
    it('should return a payment address with subaccount', async () => {
      const id = await createTestLink(aliceActor);
      const addr = await aliceActor.getPaymentAddress(id);
      expect(addr).toHaveLength(1);
      const account = addr[0]!;
      expect(account.owner.toText()).toBe(canisterId.toText());
      expect(account.subaccount).toHaveLength(1);
      expect(account.subaccount[0]).toHaveLength(32);
    });

    it('should return different subaccounts for different links', async () => {
      const id1 = await createTestLink(aliceActor);
      const id2 = await createTestLink(aliceActor);
      const addr1 = await aliceActor.getPaymentAddress(id1);
      const addr2 = await aliceActor.getPaymentAddress(id2);
      const sub1 = Array.from(addr1[0]!.subaccount[0]!);
      const sub2 = Array.from(addr2[0]!.subaccount[0]!);
      expect(sub1).not.toEqual(sub2);
    });

    it('should return empty for non-existent link', async () => {
      const addr = await aliceActor.getPaymentAddress('99999');
      expect(addr).toHaveLength(0);
    });
  });

  // ---- User Link Listing ----

  describe('myLinks', () => {
    it('should return links for the caller', async () => {
      // Create a fresh actor to isolate this test
      const testActor = pic.createActor<_SERVICE>(idlFactory, canisterId);
      const testPrincipal = Principal.fromText('aaaaa-aa'); // management canister id as test principal
      testActor.setPrincipal(testPrincipal);

      const id = await testActor.createLink({
        title: 'My Link',
        description: 'Test',
        amount: 50_000_000n,
        method: { icp: null },
        expiresAt: [],
      });

      const links = await testActor.myLinks();
      expect(links.length).toBeGreaterThanOrEqual(1);
      expect(links.some((l: PaymentLinkInfo) => l.id === id)).toBe(true);
    });

    it('should not show other users links', async () => {
      await createTestLink(aliceActor, { title: 'Alice Only' });
      const bobLinks = await bobActor.myLinks();
      expect(
        bobLinks.every((l: PaymentLinkInfo) => l.title !== 'Alice Only'),
      ).toBe(true);
    });

    it('should reject anonymous callers', async () => {
      await expect(anonActor.myLinks()).rejects.toThrow(
        /Anonymous callers not allowed/,
      );
    });
  });

  // ---- Link Deactivation / Reactivation ----

  describe('Link lifecycle', () => {
    it('should deactivate a link', async () => {
      const id = await createTestLink(aliceActor, { title: 'Deactivatable' });
      await aliceActor.deactivateLink(id);
      const info = await aliceActor.getLink(id);
      expect(info[0]!.active).toBe(false);
    });

    it('should reactivate a link', async () => {
      const id = await createTestLink(aliceActor, { title: 'Reactivatable' });
      await aliceActor.deactivateLink(id);
      await aliceActor.reactivateLink(id);
      const info = await aliceActor.getLink(id);
      expect(info[0]!.active).toBe(true);
    });

    it('should reject non-owner deactivation', async () => {
      const id = await createTestLink(aliceActor, { title: 'Protected' });
      await expect(bobActor.deactivateLink(id)).rejects.toThrow(
        /Not the link owner/,
      );
    });

    it('should reject non-owner reactivation', async () => {
      const id = await createTestLink(aliceActor, { title: 'Protected2' });
      await aliceActor.deactivateLink(id);
      await expect(bobActor.reactivateLink(id)).rejects.toThrow(
        /Not the link owner/,
      );
    });
  });

  // ---- Expiry ----

  describe('Expiry enforcement', () => {
    it('should show active link as active before expiry', async () => {
      const future = BigInt(Date.now()) * 1_000_000n + 60_000_000_000n; // 60s from now
      const id = await createTestLink(aliceActor, {
        title: 'Expires Later',
        expiresAt: [future],
      });
      const info = await aliceActor.getLink(id);
      expect(info[0]!.active).toBe(true);
    });

    it('should show expired link as inactive after time passes', async () => {
      // First, get the canister's current time by creating a link and reading its createdAt
      const probeId = await createTestLink(aliceActor, { title: 'Probe' });
      const probeInfo = await aliceActor.getLink(probeId);
      const canisterNow = probeInfo[0]!.createdAt;

      // Set expiry 2 seconds after the canister's current time
      const expiresAt = canisterNow + 2_000_000_000n;
      const id = await createTestLink(aliceActor, {
        title: 'Expires Soon',
        expiresAt: [expiresAt],
      });

      // Advance time well past expiry
      await pic.advanceTime(60_000); // 60 seconds
      await pic.tick();
      await pic.tick();

      const info = await aliceActor.getLink(id);
      expect(info[0]!.active).toBe(false);
    });
  });

  // ---- Stats ----

  describe('Stats', () => {
    it('should return stats', async () => {
      const s = await aliceActor.stats();
      expect(s.totalLinks).toBeGreaterThan(0n);
      expect(typeof s.totalPayments).toBe('bigint');
      expect(typeof s.activeLinks).toBe('bigint');
    });
  });

  // ---- HTTP Interface ----

  describe('HTTP interface', () => {
    it('should serve a payment page for valid link', async () => {
      const id = await createTestLink(aliceActor, {
        title: 'HTTP Test',
        amount: 250_000_000n,
      });

      const response = await aliceActor.http_request({
        method: 'GET',
        url: `/pay/${id}`,
        headers: [],
        body: new Uint8Array(),
      });

      expect(response.status_code).toBe(200);
      const body = new TextDecoder().decode(response.body);
      expect(body).toContain('HTTP Test');
      expect(body).toContain('ChainPay');
      expect(body).toContain('2.5 ICP');
    });

    it('should return 404 for non-existent link', async () => {
      const response = await aliceActor.http_request({
        method: 'GET',
        url: '/pay/99999',
        headers: [],
        body: new Uint8Array(),
      });
      expect(response.status_code).toBe(404);
    });

    it('should serve stats JSON', async () => {
      const response = await aliceActor.http_request({
        method: 'GET',
        url: '/api/stats',
        headers: [],
        body: new Uint8Array(),
      });
      expect(response.status_code).toBe(200);
      const body = new TextDecoder().decode(response.body);
      const stats = JSON.parse(body);
      expect(stats.totalLinks).toBeGreaterThan(0);
    });

    it('should return 404 for unknown paths', async () => {
      const response = await aliceActor.http_request({
        method: 'GET',
        url: '/unknown',
        headers: [],
        body: new Uint8Array(),
      });
      expect(response.status_code).toBe(404);
    });

    it('should show inactive link status in payment page', async () => {
      const id = await createTestLink(aliceActor, { title: 'Inactive Test' });
      await aliceActor.deactivateLink(id);

      const response = await aliceActor.http_request({
        method: 'GET',
        url: `/pay/${id}`,
        headers: [],
        body: new Uint8Array(),
      });

      expect(response.status_code).toBe(200);
      const body = new TextDecoder().decode(response.body);
      expect(body).toContain('inactive');
      expect(body).toContain('Payment Unavailable');
    });
  });

  // ---- Payment History (owner only) ----

  describe('Payment history access control', () => {
    it('should reject non-owner from viewing payment history', async () => {
      const id = await createTestLink(aliceActor, { title: 'Alice History' });
      await expect(
        bobActor.linkPaymentHistory(id),
      ).rejects.toThrow(/Not the link owner/);
    });

    it('should allow owner to view empty payment history', async () => {
      const id = await createTestLink(aliceActor, { title: 'Empty History' });
      const history = await aliceActor.linkPaymentHistory(id);
      expect(history).toHaveLength(0);
    });
  });
});
