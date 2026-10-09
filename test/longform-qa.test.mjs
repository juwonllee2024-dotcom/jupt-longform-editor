import test from 'node:test';
import assert from 'node:assert/strict';
import { runLongformQa } from '../src/qa/checks.mjs';

test('long-form QA blocks vertical or out-of-range output', async () => {
  const report = await runLongformQa({
    probe: async () => ({
      duration: 500,
      width: 1080,
      height: 1920,
      fps: 30,
      hasAudio: true,
      integratedLufs: -14.1,
      truePeakDbtp: -1.2,
    }),
  });
  assert.equal(report.passed, false);
  assert.ok(report.critical.includes('OUTPUT_DURATION_OUT_OF_RANGE'));
  assert.ok(report.critical.includes('OUTPUT_ASPECT_RATIO_INVALID'));
});

test('long-form QA accepts a compliant six-minute landscape output', async () => {
  const report = await runLongformQa({
    probe: async () => ({
      duration: 390,
      width: 1920,
      height: 1080,
      fps: 30,
      hasAudio: true,
      integratedLufs: -14.1,
      truePeakDbtp: -1.2,
    }),
  });
  assert.equal(report.passed, true);
});
