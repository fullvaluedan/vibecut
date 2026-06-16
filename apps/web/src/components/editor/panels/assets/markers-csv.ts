/**
 * Pure, wasm-free CSV builder for the markers (scene bookmarks) export.
 *
 * The caller (markers.tsx) is responsible for formatting each marker's
 * timecode the same way the list displays it and for performing the actual
 * Blob/anchor download — this module only assembles an RFC-4180 CSV string so
 * it can be unit-tested without importing `@/wasm`.
 *
 * Each row is `timecode,comment,color`. Fields that contain a comma, a double
 * quote, or a newline are wrapped in double quotes, and any internal double
 * quote is doubled, per RFC-4180.
 */

const CSV_HEADER = "timecode,comment,color";

export interface MarkerCsvRow {
	timecode: string;
	comment?: string;
	color?: string;
}

function escapeCsvField({ value }: { value: string }): string {
	if (/[",\r\n]/.test(value)) {
		return `"${value.replace(/"/g, '""')}"`;
	}
	return value;
}

export function buildMarkersCsv({ markers }: { markers: MarkerCsvRow[] }): string {
	const rows = markers.map((marker) => {
		const fields = [marker.timecode, marker.comment ?? "", marker.color ?? ""];
		return fields.map((value) => escapeCsvField({ value })).join(",");
	});
	return [CSV_HEADER, ...rows].join("\n");
}
