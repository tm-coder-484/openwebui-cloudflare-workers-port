/**
 * Frontend/backend version handshake.
 *
 * The SvelteKit build bakes `package.json`'s version into `WEBUI_VERSION` and
 * the layout reloads the page whenever `/api/version` disagrees with it — so
 * this constant must track the repo root `package.json`. `npm test` enforces it.
 */
export const WEBUI_VERSION = '0.11.3';
