import { defineConfig } from 'vitest/config';

// Standalone config so vitest does not inherit the SvelteKit setup in the repo
// root. The inline `css.postcss` also stops Vite from walking up to the root
// postcss.config.js, whose Tailwind plugin is not installed here.
export default defineConfig({
	css: { postcss: { plugins: [] } },
	test: {
		include: ['test/**/*.test.ts'],
		environment: 'node'
	}
});
