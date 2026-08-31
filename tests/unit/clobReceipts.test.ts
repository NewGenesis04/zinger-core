import { describe, expect, it } from 'vitest';

// Echo off before the module reads it — the capture is deliberately loud in
// production so a VPS run is greppable, which would drown the test reporter.
process.env.ZINGER_RECEIPT_ECHO = '0';

const { captureReceipt, captureClobCall, readReceipts } =
  await import('../../src/polymarket/clobReceipts.js');

/** Receipts accumulate in one worker-local log, so each test tags its own. */
const tag = (name: string) => `test/${name}/${Math.random().toString(36).slice(2)}`;
const findByFn = (fn: string) => readReceipts(500).filter((r) => r.fn === fn);

/**
 * INVARIANT: the capture records the response whole, and can never break a trade.
 *
 * This exists to answer three questions no one has observed the answer to —
 * the wire scale of makingAmount/takingAmount (backlog 33), the shape of a
 * slippage rejection (research doc open question 7), and how a failed sell is
 * distinguished from a lost response (backlog 34). All three are unanswerable
 * if the capture drops fields, and all three are moot if the capture can throw
 * inside live order execution.
 */
describe('INVARIANT: a CLOB receipt is captured whole', () => {
  it('preserves fields nobody anticipated', () => {
    // The entire premise: we do not know what Polymarket sends back. A
    // whitelist could only keep fields already thought of, which is exactly
    // why this does not route through liveAccount.traceLiveFill.
    const fn = tag('unanticipated');
    captureReceipt({
      fn,
      phase: 'response',
      request: { tokenId: 'token-up' },
      raw: {
        orderID: '0xabc',
        takingAmount: '26330000',
        someFieldNobodyHasSeenYet: { nested: ['surprise', 42] },
      },
    });

    const [rec] = findByFn(fn);
    expect(rec).toBeDefined();
    const raw = rec.raw as Record<string, any>;
    expect(raw.takingAmount).toBe('26330000');
    expect(raw.someFieldNobodyHasSeenYet).toEqual({ nested: ['surprise', 42] });
    // Key names are surfaced separately so the shape is scannable at a glance.
    expect(rec.rawKeys).toContain('someFieldNobodyHasSeenYet');
  });

  it('records both readings of the wire amount, so the scale settles itself', () => {
    // backlog 33: expectedShares comes from our own arithmetic, so whichever
    // of the two readings lands beside it identifies the scale.
    const fn = tag('scale');
    captureReceipt({
      fn,
      phase: 'response',
      request: { amountUsd: 8.69, maxPrice: 0.33 },
      raw: { orderID: '0xabc', takingAmount: '26330000' },
      derived: {
        expectedShares: 26.33,
        takingAmountRaw: '26330000',
        takingAsShares: 26.33,
        verificationOutcome: 'verified',
      },
    });

    const [rec] = findByFn(fn);
    expect(rec.derived?.expectedShares).toBe(26.33);
    expect(rec.derived?.takingAsShares).toBe(26.33);
  });

  it('survives BigInt, cycles, and undefined without throwing', () => {
    // viem hands back BigInts and JSON.stringify throws on them. A diagnostic
    // that can crash the order path is worse than no diagnostic.
    const cyclic: any = { orderID: '0xabc', amount: 26330000n };
    cyclic.self = cyclic;

    expect(() => captureReceipt({
      fn: tag('hostile'), phase: 'response', request: { big: 2n ** 70n }, raw: cyclic,
    })).not.toThrow();

    expect(() => captureReceipt({
      fn: tag('empty'), phase: 'response', request: {}, raw: undefined,
    })).not.toThrow();
  });

  it('serialises a BigInt rather than dropping the record', () => {
    const fn = tag('bigint');
    captureReceipt({ fn, phase: 'response', request: {}, raw: { amount: 26330000n } });
    const [rec] = findByFn(fn);
    expect(rec).toBeDefined();
    expect((rec.raw as any).amount).toBe('26330000n');
  });
});

describe('INVARIANT: capturing never changes what the caller sees', () => {
  it('returns the response object untouched', async () => {
    const response = { orderID: '0xabc', status: 'matched' };
    const out = await captureClobCall(tag('passthrough'), {}, async () => response);
    expect(out).toBe(response);
  });

  it('rethrows the original error, identity intact', async () => {
    // Callers branch on err.code (UNVERIFIED_FILL) — wrapping would break them.
    const boom: any = new Error('slippage exceeded');
    boom.code = 'REJECTED';
    const caught = await captureClobCall(tag('rethrow'), {}, async () => { throw boom; })
      .then(() => null, (e) => e);
    expect(caught).toBe(boom);
    expect(caught.code).toBe('REJECTED');
  });

  it('captures the rejection body, which is where a slippage reason would live', async () => {
    // Research doc open question 7. If a rejected order throws rather than
    // returning success:false, the exchange's reason is in the HTTP body.
    const fn = tag('rejection');
    const httpErr: any = new Error('Request failed with status code 400');
    httpErr.response = { status: 400, data: { error: 'not enough balance / allowance' } };

    await captureClobCall(fn, { side: 'SELL', minPrice: 0.25 }, async () => { throw httpErr; })
      .catch(() => {});

    const [rec] = findByFn(fn);
    expect(rec.phase).toBe('throw');
    expect(rec.error?.status).toBe(400);
    expect(rec.error?.body).toEqual({ error: 'not enough balance / allowance' });
    expect(rec.request.minPrice).toBe(0.25);
  });

  it('captures a success:false body, the other shape a rejection could take', async () => {
    // assertOrderAccepted passes on orderID presence alone, so this shape could
    // otherwise be recorded as a fill. Capturing happens before that check.
    const fn = tag('successfalse');
    const body = { success: false, errorMsg: 'order could not be fully filled' };
    await captureClobCall(fn, { side: 'SELL' }, async () => body);

    const [rec] = findByFn(fn);
    expect(rec.phase).toBe('response');
    expect((rec.raw as any).success).toBe(false);
    expect((rec.raw as any).errorMsg).toBe('order could not be fully filled');
  });
});
