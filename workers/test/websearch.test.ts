import { describe, expect, it } from 'vitest';
import { htmlToText } from '../src/lib/websearch';

describe('htmlToText', () => {
	it('strips markup, scripts and styles', () => {
		const html = `
			<html><head><style>body{color:red}</style><script>alert(1)</script></head>
			<body><h1>Title</h1><p>Hello &amp; welcome to <b>Workers</b>.</p></body></html>`;
		const text = htmlToText(html);
		expect(text).toBe('Title Hello & welcome to Workers .');
		expect(text).not.toContain('alert');
		expect(text).not.toContain('color:red');
	});

	it('decodes the entities that show up in titles', () => {
		expect(htmlToText('<p>Tom&#39;s &quot;quoted&quot; &lt;tag&gt;</p>')).toBe(
			'Tom\'s "quoted" <tag>'
		);
	});
});
