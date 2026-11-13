/**
 * Admin CLI. Talks to the database directly; run it on the gateway host (or inside the container).
 *   pnpm admin invites:create [--count N] [--label TEXT]
 *   pnpm admin invites:list
 *   pnpm admin invites:revoke <invite-id|code>
 *   pnpm admin balances:show          (totals per unit; there is no per-balance listing)
 *   pnpm admin revenue:show
 *   pnpm admin revenue:export --unit usd|sat [--mint URL] [--amount N]
 *   pnpm admin prices:show [--unit usd|sat]
 */
import { parseArgs } from 'node:util';
import { loadConfig, type Unit } from './config.ts';
import { buildDeps } from './deps.ts';
import { setLogSilent } from './log.ts';
import { displayPrice, MSUB_PER_UNIT } from './pricing.ts';
import { ExportError, issueExport, oweExport, planExport, revenue } from './revenue.ts';

setLogSilent(true);
const [cmd, ...rest] = process.argv.slice(2);
const { values, positionals } = parseArgs({
  args: rest,
  allowPositionals: true,
  options: { count: { type: 'string' }, label: { type: 'string' }, unit: { type: 'string' }, mint: { type: 'string' }, amount: { type: 'string' }, json: { type: 'boolean' } },
});

const config = loadConfig();
const d = buildDeps(config);

function table(rows: object[]) {
  if (values.json) console.log(JSON.stringify(rows, null, 2));
  else console.table(rows);
}

switch (cmd) {
  case 'invites:create': {
    const n = Number(values.count ?? 1);
    const out = Array.from({ length: n }, () => d.invites.create(values.label));
    table(out.map((o) => ({ id: o.id, code: o.code })));
    console.error('Codes are shown once; only their hashes are stored.');
    break;
  }
  case 'invites:list':
    table(d.invites.list() as object[]);
    break;
  case 'invites:revoke': {
    const ok = d.invites.revoke(positionals[0] ?? '');
    console.log(ok ? 'revoked' : 'not found');
    break;
  }
  case 'balances:show':
    table(
      d.ledger.totals().map((t) => ({
        unit: t.unit,
        balances: t.balances,
        total: t.balance_msub / MSUB_PER_UNIT,
        reserved: t.reserved_msub / MSUB_PER_UNIT,
        frozen: t.frozen,
      })),
    );
    break;
  case 'revenue:show':
    table(
      config.env.BELLOWS_UNITS.map((u) => {
        const r = revenue(d, u);
        return { unit: u, wallet: r.unspent, other_mints: r.other_unspent, owed_payouts: r.owed, customer_balances: r.liabilities, sweepable: r.sweepable };
      }),
    );
    break;
  case 'revenue:export': {
    const unit = (values.unit ?? 'usd') as Unit;
    let plan;
    try {
      plan = planExport(d, unit, { mint: values.mint, amount: values.amount ? Number(values.amount) : undefined });
    } catch (e) {
      console.error(e instanceof ExportError ? e.message : String(e));
      process.exit(1);
    }
    const { id } = oweExport(d, { unit, mint: plan.mint, amount: plan.amount, source: 'cli' });
    const token = await issueExport(d, id);
    console.error(`Exported ${plan.amount} ${unit} from ${plan.mint} (export ${id}). Store this token safely:`);
    console.log(token);
    break;
  }
  case 'prices:show': {
    const unit = (values.unit ?? 'usd') as Unit;
    const rate = unit === 'sat' ? await d.rates.get() : undefined;
    if (unit === 'sat' && !rate) console.error('BTC/USD rate unavailable');
    table(
      config.catalog.models.map((m) => ({
        id: m.id,
        tier: config.catalog.suppliers[m.supplier]!.tier,
        [`in_${unit}_per_mtok`]: displayPrice(m.input_usd_per_mtok, config.env.BELLOWS_MARKUP, unit, rate)?.toFixed(unit === 'usd' ? 4 : 1),
        [`out_${unit}_per_mtok`]: displayPrice(m.output_usd_per_mtok, config.env.BELLOWS_MARKUP, unit, rate)?.toFixed(unit === 'usd' ? 4 : 1),
        verified: m.price_verified,
        uncensored: m.uncensored,
      })),
    );
    if (rate) console.error(`BTC/USD ${rate} (markup ${config.env.BELLOWS_MARKUP})`);
    break;
  }
  default:
    console.error('commands: invites:create invites:list invites:revoke balances:show revenue:show revenue:export prices:show');
    process.exit(cmd ? 1 : 0);
}
d.db.close();
