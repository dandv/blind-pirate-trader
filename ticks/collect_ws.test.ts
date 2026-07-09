/**
 * Integration: collect_ws writes live Kraken ticks into VicMet at VICMET_URL_TEST.
 *
 * Requires VicMet already running (e.g. `deno task vicmet` / `deno task ticks:vicmet`).
 * Load `VICMET_URL_TEST` via `--env-file` / `deno.envFile`. Do not read env at module
 * top-level — the Deno LSP discovers tests by loading the module, and a throw there
 * yields "No tests have been found".
 */
import { assert, assertGreater, assertExists } from '@std/assert';
import { VicMet } from './VicMet.ts';

const MODULE_DIR = new URL('.', import.meta.url).pathname.replace(/\/$/, '');
const COLLECT_TIMEOUT_MS = 45_000;
const POLL_MS = 2_000;

const silentLogger = {
   debug() {},
   info() {},
   warn() {},
   error() {},
};

function requiredEnv(key: string): string {
   const value = Deno.env.get(key);
   assertExists(value, `Missing required environment variable: ${key}`);
   return value;
}

/** Env for children: drop LD_ and DYLD_ vars so scoped --allow-run is enough. */
function childEnv(extra: Record<string, string> = {}): Record<string, string> {
   const env: Record<string, string> = {};
   for (const [k, v] of Object.entries(Deno.env.toObject())) {
      if (k.startsWith('LD_') || k.startsWith('DYLD_')) continue;
      env[k] = v;
   }
   return { ...env, ...extra };
}

async function isVicMetUp(url: string): Promise<boolean> {
   try {
      const res = await fetch(`${url}/health`);
      return res.ok;
   } catch {
      return false;
   }
}

async function recentSampleCount(url: string): Promise<number> {
   const vm = new VicMet({ url, logger: silentLogger });
   await vm.flush();
   // count_over_time so we detect new points even when the symbol set is unchanged
   const text = await vm.getText('query', {
      query: 'sum(count_over_time({__name__=~"ticks_.*",exchange="kraken"}[3m]))',
   });
   const json = JSON.parse(text) as {
      status: string
      data?: { result?: Array<{ value: [number, string] }> }
   };
   if (json.status !== 'success' || !json.data?.result?.length)
      return 0;
   return Number(json.data.result[0]!.value[1]) || 0;
}

Deno.test('collect_ws: when pointed at VicMet on VICMET_URL_TEST, captures some Kraken ticks', async () => {
   const vicmetUrl = requiredEnv('VICMET_URL_TEST');
   console.log(`VicMet target ${vicmetUrl}`);

   assert(
      await isVicMetUp(vicmetUrl),
      `VicMet not running at ${vicmetUrl} — start it in another terminal: deno task vicmet (or deno task ticks:vicmet)`,
   );

   let collector: Deno.ChildProcess | undefined;

   try {
      const before = await recentSampleCount(vicmetUrl);
      console.log(`Recent ticks_* samples before collect: ${before}`);

      console.log('Starting collect_ws...');
      collector = new Deno.Command('deno', {
         args: [
            'run',
            `--config=${MODULE_DIR}/deno.jsonc`,
            '--allow-net=api.kraken.com,ws.kraken.com,127.0.0.1,localhost',
            '--allow-env=VICMET_URL',
            '--allow-read',
            '--allow-write',
            '--allow-sys=homedir',
            `${MODULE_DIR}/collect_ws.ts`,
         ],
         cwd: MODULE_DIR,
         clearEnv: true,
         env: childEnv({ VICMET_URL: vicmetUrl }),
         stdout: 'piped',
         stderr: 'piped',
      }).spawn();

      const deadline = Date.now() + COLLECT_TIMEOUT_MS;
      let after = before;
      while (Date.now() < deadline) {
         await new Promise((r) => setTimeout(r, POLL_MS));
         // Bail early if the collector already exited (connect failure, etc.).
         const raced = await Promise.race([
            collector.status.then((s) => s),
            new Promise<null>((r) => setTimeout(() => r(null), 0)),
         ]);
         if (raced) {
            const [out, err] = await Promise.all([
               collector.stdout.text(),
               collector.stderr.text(),
            ]);
            throw new Error(
               `collect_ws exited early (code=${raced.code})\n--- stdout ---\n${out}\n--- stderr ---\n${err}`,
            );
         }
         after = await recentSampleCount(vicmetUrl);
         console.log(`Recent ticks_* samples: ${after} (need > ${before})`);
         if (after > before) break;
      }

      if (after <= before) {
         try {
            collector.kill('SIGTERM');
         } catch { /* ignore */ }
         const status = await collector.status;
         const [out, err] = await Promise.all([
            collector.stdout.text(),
            collector.stderr.text(),
         ]);
         collector = undefined;
         throw new Error(
            `expected new ticks_* samples after collecting (before=${before}, after=${after}, exit=${status.code})\n--- stdout ---\n${out}\n--- stderr ---\n${err}`,
         );
      }

      assertGreater(after, before);
      assert(after > 0, 'VicMet should contain recent ticks_* samples for exchange=kraken');
      console.log(`Captured ticks: samples ${before} → ${after}`);
   } finally {
      if (collector) {
         try {
            collector.kill('SIGTERM');
         } catch { /* already exited */ }
         await collector.status;
         await Promise.all([collector.stdout.cancel(), collector.stderr.cancel()]);
      }
   }
});
