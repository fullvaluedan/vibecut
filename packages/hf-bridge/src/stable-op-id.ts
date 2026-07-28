/**
 * Deterministic id for an op (djb2 over its identity fields) so re-planning the
 * same output is stable. Kept in its own dependency-free leaf module so client
 * code (clamp-cut-extent) can import it WITHOUT pulling the barrel's Node-only
 * graph (author.ts imports node:child_process). author.ts re-exports it for the
 * barrel; downstream span surgery mints split-op ids in the same namespace
 * instead of copying the hash.
 */
export function stableOpId(op: {
	op: string;
	startSec: number;
	endSec: number;
	targetStartSec?: number;
}): string {
	const key = `${op.op}|${op.startSec}|${op.endSec}|${op.targetStartSec ?? ""}`;
	let h = 5381;
	for (let i = 0; i < key.length; i++) {
		h = ((h << 5) + h + key.charCodeAt(i)) >>> 0;
	}
	return `op_${h.toString(36)}`;
}
