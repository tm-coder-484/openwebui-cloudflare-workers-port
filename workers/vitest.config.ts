import { defineConfig } from 'vitest/config';

// Standalone config so vitest does not inherit the SvelteKit setup in the repo root.
export default defineConfig({
	test: {
		include: ['test/**/*.test.ts'],
		environment: 'node'
	}
});
