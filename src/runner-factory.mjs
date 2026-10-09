import { createLongformCondenseRunner } from './condense/runner.mjs';
import { createRunnerWithDefaults } from './runner.mjs';

export function createRunnerForMode({ mode = 'facecam', ...dependencies } = {}) {
  if (mode === 'longform-condense') return createLongformCondenseRunner(dependencies);
  if (mode === 'facecam') return createRunnerWithDefaults(dependencies);
  throw new Error(`unknown video editor mode: ${mode}`);
}
