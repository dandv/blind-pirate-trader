import { createFileRoute } from '@tanstack/react-router';

// The browser only hits same-origin /api/vm/*; this server-side proxy fetches
// the upstream VictoriaMetrics (via the vmauth gateway). Override with
// VM_UPSTREAM_URL if needed.
const VM_UPSTREAM =
   process.env.VM_UPSTREAM_URL ?? 'https://vicmet.dandv.me';

async function proxy(request: Request, splat: string): Promise<Response> {
   const url = new URL(request.url);
   const target = `${VM_UPSTREAM.replace(/\/$/, '')}/${splat}${url.search}`;
   try {
      const upstream = await fetch(target, {
         method: request.method,
         headers: { accept: 'application/json' },
         body: request.method === 'GET' || request.method === 'HEAD'
            ? undefined
            : await request.text(),
      });
      const body = await upstream.text();
      if (!upstream.ok) {
         console.error(
            '[vm-proxy] upstream non-OK',
            upstream.status,
            upstream.statusText,
            target,
            '\nbody:',
            body,
         );
      }
      return new Response(body, {
         status: upstream.status,
         headers: {
            'content-type': upstream.headers.get('content-type') ?? 'application/json',
            'cache-control': 'no-store',
            'x-vm-upstream-status': String(upstream.status),
         },
      });
   } catch (e) {
      console.error('[vm-proxy] upstream fetch threw', target, e);
      return new Response(
         JSON.stringify({ status: 'error', error: `Upstream fetch failed: ${(e as Error).message}` }),
         { status: 502, headers: { 'content-type': 'application/json' } },
      );
   }
}

export const Route = createFileRoute('/api/vm/$')({
   server: {
      handlers: {
         GET: async ({ request, params }) => proxy(request, params._splat ?? ''),
         POST: async ({ request, params }) => proxy(request, params._splat ?? ''),
      },
   },
});

