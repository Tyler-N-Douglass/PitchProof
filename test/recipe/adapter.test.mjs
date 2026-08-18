/**
 * The optional runtime adapter (§9), driven entirely by a stubbed transport.
 *
 * Nothing in this file may touch a real network, and nothing in `src/recipe`
 * can: `http` is injected on every call. The tests below hold the four
 * properties the spec names — injected transport, key never leaving the call,
 * `illustrative` at creation, and failure as a `Result` err rather than a throw
 * or a silent empty rendition — plus the absence proof L10 needs.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  runAdapter, assertNoAdapterSecrets, noteAdapterSecret, forgetAdapterSecrets,
  adapterSecretCount, blocksFromAdapterPayload, recipeById, hasPromotionRecord,
  promoteProvenance, verifyProvenance,
} from '../../src/recipe/index.js';
import { validateRendition } from '../../src/core/contracts.js';
import { retailSpecimen } from '../fixtures/recipe/specimens.mjs';

const KEY = 'sk-live-8f3c2a91d47b6e05aa19bc73de24f018';
const ENDPOINT = 'https://generate.example.invalid/v1/renditions';
const RECIPE = recipeById('locale-fanout');

/**
 * A transport stub. Records what it was called with, answers what it was told to.
 * @param {{status?: number, body?: string, throws?: string}} plan
 */
function stubHttp(plan = {}) {
  /** @type {{url: string, init: any}[]} */
  const calls = [];
  const http = async (url, init) => {
    calls.push({ url, init });
    if (plan.throws) throw new Error(plan.throws);
    return {
      ok: plan.status === undefined ? true : plan.status >= 200 && plan.status < 300,
      status: plan.status === undefined ? 200 : plan.status,
      text: async () => (plan.body === undefined ? JSON.stringify({ blocks: [{ type: 'paragraph', text: 'Northwind connects brands and retailers in one plan.' }] }) : plan.body),
    };
  };
  return { http, calls };
}

test.afterEach(() => forgetAdapterSecrets());

test('success stamps illustrative, whatever the endpoint or the caller wants', async () => {
  const specimen = retailSpecimen();
  const { http, calls } = stubHttp({
    body: JSON.stringify({
      label: 'de-DE',
      provenance: 'client-supplied',
      blocks: [{ type: 'heading', level: 1, text: 'Retail media, unified across every market' }],
    }),
  });

  const result = await runAdapter(RECIPE, specimen, { endpoint: ENDPOINT, key: KEY, http });
  assert.equal(result.ok, true);
  const rendition = result.value;

  assert.equal(rendition.provenance, 'illustrative');
  assert.equal(rendition.producedBy, 'adapter');
  assert.equal(rendition.label, 'de-DE');
  assert.equal(rendition.specimenId, specimen.id);
  assert.equal(rendition.recipeId, RECIPE.id);
  assert.equal(hasPromotionRecord(rendition), false);
  assert.deepEqual(verifyProvenance(rendition), []);

  /** @type {string[]} */
  const errs = [];
  validateRendition(rendition, 'rendition', errs);
  assert.deepEqual(errs, []);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, ENDPOINT);
  assert.equal(calls[0].init.method, 'POST');
});

test('the key never appears in the rendition or in its serialization', async () => {
  const { http, calls } = stubHttp();
  const result = await runAdapter(RECIPE, retailSpecimen(), { endpoint: ENDPOINT, key: KEY, http });
  assert.equal(result.ok, true);

  const serialized = JSON.stringify(result.value);
  assert.ok(!serialized.includes(KEY), 'the key is not in the rendition');
  assert.ok(!serialized.includes('sk-live'), 'not even a fragment of it');
  assert.ok(!serialized.includes(ENDPOINT), 'nor the endpoint');
  assert.ok(!/authorization/i.test(serialized));
  assert.deepEqual(assertNoAdapterSecrets(result.value, { path: 'rendition' }), []);

  // The key travels in one header on the caller's own transport, and nowhere else.
  assert.equal(calls[0].init.headers.authorization, `Bearer ${KEY}`);
  assert.ok(!calls[0].init.body.includes(KEY), 'the request body does not carry it either');
});

test('assertNoAdapterSecrets finds a configured key wherever it ended up', () => {
  forgetAdapterSecrets();
  assert.deepEqual(assertNoAdapterSecrets({ notes: KEY }), [
    'value.notes: looks like an sk- prefixed API key',
  ], 'shape detection works with no session key configured');

  noteAdapterSecret('a-key-with-no-recognisable-shape-at-all-1234');
  assert.equal(adapterSecretCount(), 1);

  assert.deepEqual(assertNoAdapterSecrets({ blocks: [{ text: 'a-key-with-no-recognisable-shape-at-all-1234' }] }), [
    'value.blocks[0].text: contains a configured adapter key verbatim',
  ]);
  assert.deepEqual(assertNoAdapterSecrets(['Bearer a-key-with-no-recognisable-shape-at-all-1234 trailing']), [
    'value[0]: embeds a configured adapter key',
  ]);
  assert.deepEqual(assertNoAdapterSecrets({ safe: 'nothing to see here' }), []);
});

test('assertNoAdapterSecrets refuses adapter configuration by property name', () => {
  const findings = assertNoAdapterSecrets({ settings: { endpoint: ENDPOINT, apiKey: 'x', unrelated: 'fine' } });
  assert.equal(findings.length, 2);
  assert.ok(findings.some((f) => /settings\.endpoint/.test(f)));
  assert.ok(findings.some((f) => /settings\.apiKey/.test(f)));
  assert.deepEqual(assertNoAdapterSecrets({ settings: { endpoint: '' } }), [], 'an empty value is not a leak');
});

test('assertNoAdapterSecrets recognises credential shapes it has never been told about', () => {
  const cases = [
    ['sk-abcdefghijklmnopqrstuvwx', /sk- prefixed/],
    ['Authorization: Bearer abcdefghijklmnopqrst', /bearer token/],
    ['eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.sig', /JSON Web Token/],
    ['AKIAIOSFODNN7EXAMPLE', /AWS access key id/],
    ['ghp_abcdefghijklmnopqrstuvwxyz0123456789', /GitHub personal access token/],
    ['xoxb-1234567890-abcdefghij', /Slack token/],
  ];
  for (const [value, expected] of cases) {
    const findings = assertNoAdapterSecrets({ v: value });
    assert.equal(findings.length, 1, value);
    assert.match(findings[0], expected);
  }
});

test('assertNoAdapterSecrets walks maps, sets, arrays and cycles without hanging', () => {
  const cyclic = { name: 'root' };
  cyclic.self = cyclic;
  cyclic.list = [new Map([['a', 'sk-abcdefghijklmnopqrstuvwx']]), new Set(['clean'])];
  const findings = assertNoAdapterSecrets(cyclic);
  assert.equal(findings.length, 1);
  assert.match(findings[0], /list\[0\]\.a/);
});

test('a whole proof-shaped object with no adapter configuration is clean', async () => {
  const { http } = stubHttp();
  const result = await runAdapter(RECIPE, retailSpecimen(), { endpoint: ENDPOINT, key: KEY, http });
  const proofish = { specimens: [retailSpecimen()], renditions: [result.value], recipes: [RECIPE] };
  assert.deepEqual(assertNoAdapterSecrets(proofish, { path: 'proof' }), []);
});

test('failure is a Result err — a non-2xx status', async () => {
  const { http } = stubHttp({ status: 503 });
  const result = await runAdapter(RECIPE, retailSpecimen(), { endpoint: ENDPOINT, key: KEY, http });
  assert.equal(result.ok, false);
  assert.match(result.error, /endpoint answered 503/);
});

test('failure is a Result err — a transport that throws', async () => {
  const { http } = stubHttp({ throws: 'ECONNREFUSED' });
  const result = await runAdapter(RECIPE, retailSpecimen(), { endpoint: ENDPOINT, key: KEY, http });
  assert.equal(result.ok, false);
  assert.match(result.error, /transport failed — ECONNREFUSED/);
});

test('failure is a Result err — never a silent empty rendition', async () => {
  // Note that a plain-text body is *not* a failure: an endpoint answering with
  // prose is a supported shape, and it goes through the paste parser.
  for (const body of ['', '   ', '{}', '{"blocks":[]}', '{"blocks":[{"type":"nope"}]}', '{"text":"   "}']) {
    const { http } = stubHttp({ body });
    const result = await runAdapter(RECIPE, retailSpecimen(), { endpoint: ENDPOINT, key: KEY, http });
    assert.equal(result.ok, false, `body ${JSON.stringify(body)} must not produce a rendition`);
    assert.match(result.error, /empty response|no usable content/);
  }
});

test('the adapter refuses to run without an injected transport, an endpoint or a key', async () => {
  const specimen = retailSpecimen();
  const { http } = stubHttp();
  assert.match((await runAdapter(RECIPE, specimen, { endpoint: ENDPOINT, key: KEY })).error, /http transport must be injected/);
  assert.match((await runAdapter(RECIPE, specimen, { endpoint: '', key: KEY, http })).error, /no endpoint is configured/);
  assert.match((await runAdapter(RECIPE, specimen, { endpoint: ENDPOINT, key: '', http })).error, /no key is configured/);
  assert.match((await runAdapter(null, specimen, { endpoint: ENDPOINT, key: KEY, http })).error, /recipe is required/);
  assert.match((await runAdapter(RECIPE, null, { endpoint: ENDPOINT, key: KEY, http })).error, /specimen is required/);
});

test('adapter output that is prose rather than blocks goes through the paste parser', async () => {
  const { http } = stubHttp({ body: JSON.stringify({ text: '# Retail media\n\nOne plan for every market.' }) });
  const result = await runAdapter(RECIPE, retailSpecimen(), { endpoint: ENDPOINT, key: KEY, http, label: 'fr-FR' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.value.blocks, [
    { type: 'heading', level: 1, text: 'Retail media' },
    { type: 'paragraph', text: 'One plan for every market.' },
  ]);
  assert.equal(result.value.label, 'fr-FR');
  assert.equal(result.value.provenance, 'illustrative');
});

test('the §18.2 guard reports on adapter output rather than rejecting the user\'s own pipeline', async () => {
  const { http } = stubHttp({
    body: JSON.stringify({ blocks: [{ type: 'paragraph', text: 'Customers see a 42% lift, says Nike.' }] }),
  });
  const result = await runAdapter(RECIPE, retailSpecimen(), { endpoint: ENDPOINT, key: KEY, http });
  assert.equal(result.ok, true, 'the adapter is the user\'s own pipeline; its output is surfaced, not silently dropped');
  assert.match(result.value.notes, /need a human check before use/);
  assert.match(result.value.notes, /\[\[pp-unsourced:1;n=2;kinds=named-entity,numeral\]\]/);
  assert.equal(result.value.provenance, 'illustrative');
});

test('clean adapter output says so in its notes', async () => {
  const { http } = stubHttp();
  const result = await runAdapter(RECIPE, retailSpecimen(), { endpoint: ENDPOINT, key: KEY, http });
  assert.match(result.value.notes, /is present in the source specimen/);
  assert.ok(!/pp-unsourced/.test(result.value.notes));
});

test('an adapter rendition can only reach verified-by-user through an explicit promotion', async () => {
  const { http } = stubHttp();
  const result = await runAdapter(RECIPE, retailSpecimen(), { endpoint: ENDPOINT, key: KEY, http });
  const rendition = result.value;
  assert.equal(rendition.provenance, 'illustrative');

  const promoted = promoteProvenance(rendition, { by: 'Dana Okafor', at: '2026-08-18T09:30:00.000Z' });
  assert.equal(promoted.provenance, 'verified-by-user');
  assert.equal(hasPromotionRecord(promoted), true);
  assert.equal(promoted.producedBy, 'adapter', 'the record does not launder where it came from');
  assert.deepEqual(verifyProvenance(promoted), []);
  assert.deepEqual(assertNoAdapterSecrets(promoted, { path: 'rendition' }), []);
});

test('blocksFromAdapterPayload accepts the shapes it documents and refuses the rest', () => {
  assert.deepEqual(blocksFromAdapterPayload({ blocks: [{ type: 'paragraph', text: 'a' }] }), {
    blocks: [{ type: 'paragraph', text: 'a' }],
    label: null,
  });
  assert.deepEqual(blocksFromAdapterPayload({ label: 'x', markdown: '# T' }), {
    blocks: [{ type: 'heading', level: 1, text: 'T' }],
    label: 'x',
  });
  assert.deepEqual(blocksFromAdapterPayload('plain prose, and a full stop.'), {
    blocks: [{ type: 'paragraph', text: 'plain prose, and a full stop.' }],
    label: null,
  });
  assert.equal(blocksFromAdapterPayload(null), null);
  assert.equal(blocksFromAdapterPayload(42), null);
  assert.equal(blocksFromAdapterPayload({ blocks: [] }), null);
  assert.equal(blocksFromAdapterPayload({ blocks: [{ type: 'heading' }] }), null, 'a malformed block is a failure, not a silent drop');
});

test('forgetAdapterSecrets clears the session, and only fingerprints were ever held', () => {
  forgetAdapterSecrets();
  assert.equal(adapterSecretCount(), 0);
  const fingerprint = noteAdapterSecret(KEY);
  assert.match(fingerprint, /^[0-9a-f]{64}$/);
  assert.notEqual(fingerprint, KEY);
  assert.equal(adapterSecretCount(), 1);
  forgetAdapterSecrets();
  assert.equal(adapterSecretCount(), 0);
});
