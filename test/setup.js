import 'fake-indexeddb/auto';
import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// `globals: false` in vite.config.js means no auto-cleanup hook is
// registered by @testing-library/react itself -- wire it up explicitly so
// each test's rendered tree is unmounted before the next test runs.
afterEach(() => {
  cleanup();
});
