import { describe, expect, test } from "bun:test";
import { buildProbeHtml } from "../renderer";

const COMP = `<!doctype html>
<html><body>
<div data-composition-id="root" data-start="0" data-width="1920" data-height="1080" data-duration="90">
  <div class="clip" data-start="0" data-duration="90" data-track-index="0"></div>
</div>
</body></html>`;

describe("buildProbeHtml - probe duration math", () => {
	test("caps the ROOT data-duration to the probe length", () => {
		const out = buildProbeHtml(COMP, 4);
		expect(out).toContain('data-composition-id="root" data-start="0" data-width="1920" data-height="1080" data-duration="4"');
		// only the root (first) data-duration is rewritten
		expect(out).toContain('data-duration="90" data-track-index="0"');
	});

	test("never EXTENDS the comp: a chunk shorter than the probe cap probes its full length", () => {
		const short = COMP.replace('data-duration="90"', 'data-duration="2"');
		const out = buildProbeHtml(short, 4);
		expect(out).toContain('data-duration="2"');
		expect(out).not.toContain('data-duration="4"');
	});

	test("fractional caps round to milliseconds", () => {
		const out = buildProbeHtml(COMP, 3.3333333);
		expect(out).toContain('data-duration="3.333"');
	});

	test("a comp with no data-duration cannot be probe-rendered", () => {
		expect(() => buildProbeHtml("<html><body></body></html>", 4)).toThrow(
			/no root data-duration/,
		);
	});

	test("an unreadable data-duration is rejected", () => {
		const bad = COMP.replace('data-duration="90"', 'data-duration="0"');
		expect(() => buildProbeHtml(bad, 4)).toThrow(/unreadable data-duration/);
	});
});
