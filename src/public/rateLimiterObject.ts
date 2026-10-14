import { DurableObject } from "cloudflare:workers";
import { takeRateSlot, type RateDecision, type WindowState, type WindowStore } from "./rateWindows.ts";

// One instance per client IP (`idFromName("ip:" + CF-Connecting-IP)`), so the
// count is global and strongly consistent, unlike the per-location Workers
// Rate Limiting binding. `take` never awaits between read and write, so two
// concurrent calls cannot both see the last free slot. Holds no IP itself:
// only window start times and counts.
export class PublicRateLimiter extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		ctx.storage.sql.exec(
			"CREATE TABLE IF NOT EXISTS windows (name TEXT PRIMARY KEY, start INTEGER NOT NULL, count INTEGER NOT NULL)",
		);
	}

	take(): RateDecision {
		const sql = this.ctx.storage.sql;
		const store: WindowStore = {
			get(name) {
				const row = sql
					.exec<{ start: number; count: number }>("SELECT start, count FROM windows WHERE name = ?", name)
					.toArray()[0];
				return row ? ({ start: Number(row.start), count: Number(row.count) } satisfies WindowState) : undefined;
			},
			set(name, state) {
				sql.exec(
					"INSERT INTO windows (name, start, count) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET start = excluded.start, count = excluded.count",
					name,
					state.start,
					state.count,
				);
			},
		};
		return this.ctx.storage.transactionSync(() => takeRateSlot(store, Date.now()));
	}
}
