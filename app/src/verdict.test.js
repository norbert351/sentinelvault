import { test } from 'node:test';
import assert from 'node:assert/strict';
import { screen } from './verdict.js';

test('clean token approves with low risk', () => {
  const r = screen([
    { intent: 'URL_SCAN', confidence: 0.98, data: { risk: 0.02 } },
    { intent: 'FRAUD_DETECTION', confidence: 0.95, data: { risk: 0.05 } },
    { intent: 'CVE_LOOKUP', confidence: 0.99, data: { severity: null } },
    { intent: 'TVL_LOOKUP', confidence: 0.9, data: { tvlUsd: 2_000_000 } },
    { intent: 'TOKEN_HOLDER_COUNT', confidence: 0.85, data: { top1Percent: 25 } },
    { intent: 'SENTIMENT_ANALYSIS', confidence: 0.8, data: { sentiment: 'positive' } },
  ]);
  assert.equal(r.verdict, 'APPROVE');
  assert.ok(r.riskScore < 45, `riskScore was ${r.riskScore}`);
  assert.ok(r.confidence >= 40);
  assert.ok(r.signals.length === 6);
});

test('scam token blocks (the deal it catches)', () => {
  const r = screen([
    { intent: 'URL_SCAN', confidence: 0.99, data: { risk: 0.95 } },
    { intent: 'FRAUD_DETECTION', confidence: 0.97, data: { risk: 0.9 } },
    { intent: 'CVE_LOOKUP', confidence: 0.99, data: { severity: 'CRITICAL' } },
    { intent: 'TOKEN_HOLDER_COUNT', confidence: 0.8, data: { top1Percent: 95 } },
    { intent: 'TVL_LOOKUP', confidence: 0.85, data: { tvlUsd: 200 } },
    { intent: 'SENTIMENT_ANALYSIS', confidence: 0.9, data: { sentiment: 'negative' } },
  ]);
  assert.equal(r.verdict, 'BLOCK');
  assert.ok(r.riskScore > 70, `riskScore was ${r.riskScore}`);
  assert.ok(r.reasons.some((x) => x.includes('CVE_LOOKUP') || x.includes('FRAUD')));
});

test('moderate evidence flags for human review', () => {
  const r = screen([
    { intent: 'URL_SCAN', confidence: 0.9, data: { risk: 0.5 } },
    { intent: 'FRAUD_DETECTION', confidence: 0.8, data: { risk: 0.4 } },
    { intent: 'SENTIMENT_ANALYSIS', confidence: 0.7, data: { sentiment: 'neutral' } },
  ]);
  assert.equal(r.verdict, 'FLAG');
});

test('no signals flags with zero confidence, never fabricates', () => {
  const r = screen([]);
  assert.equal(r.verdict, 'FLAG');
  assert.equal(r.confidence, 0);
  assert.ok(r.reasons.length >= 1);
});

test('deterministic: same input, same output', () => {
  const sig = [
    { intent: 'FRAUD_DETECTION', confidence: 0.9, data: { risk: 0.6 } },
    { intent: 'URL_SCAN', confidence: 0.9, data: { risk: 0.55 } },
  ];
  assert.deepEqual(screen(sig), screen(sig));
});

test('empty miner answer (unknown intent) never overstates risk', () => {
  const r = screen([{ intent: 'CVE_LOOKUP', confidence: 0.99, data: { severity: undefined } }]);
  assert.notEqual(r.verdict, 'BLOCK');
});