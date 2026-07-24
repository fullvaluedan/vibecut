/** U1 verification: run the hallucination guard over each eval fixture's
 * cached words/segments/envelope and report hit counts. Zero hits on a fixture
 * means its adapter payloads (and eval cache keys) are byte-identical after
 * U1; nonzero means a budgeted cache re-prime for that fixture (KTD7). */
import fs from "node:fs";
import path from "node:path";
import { guardHallucinations } from "@/features/ai-generate/director/hallucination-guard";
import type { DirectorEvalFixture } from "@/features/ai-generate/director/eval/fixture-types";

const dir = path.resolve("eval-fixtures");
for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".json"))) {
	const fixture = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")) as DirectorEvalFixture;
	if (!fixture.rawSegments?.length || !fixture.envelope?.length) {
		console.log(`${fixture.name}: SKIP (missing rawSegments/envelope)`);
		continue;
	}
	const words = fixture.rawWords.map((w) => ({ text: w.text, start: w.start, end: w.end }));
	const segments = fixture.rawSegments.map((s) => ({ text: s.text, start: s.start, end: s.end }));
	const result = guardHallucinations({
		words,
		segments,
		envelope: fixture.envelope,
		windowSec: fixture.envelopeWindowSec ?? 0.05,
	});
	const flaggedSegs = segments.length - result.cleanSegments.length;
	const flaggedWords = words.length - result.cleanWords.length;
	console.log(
		`${fixture.name}: ${flaggedSegs} flagged segment(s), ${flaggedWords} excluded word(s), ` +
			`${result.hallucinatedSpans.length} span(s) ${JSON.stringify(result.hallucinatedSpans.map((s) => [+s.startSec.toFixed(1), +s.endSec.toFixed(1)]))}`,
	);
}
