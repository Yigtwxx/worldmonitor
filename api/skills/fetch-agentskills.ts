export const config = { runtime: 'edge' };

// @ts-expect-error -- JS module, no declaration file
import { getCorsHeaders } from '../_cors.js';
import { readJsonFromUpstash, setCachedData } from '../_upstash-json.js';
import { ENDPOINT_RATE_POLICIES, checkScopedRateLimit, getClientIp } from '../../server/_shared/rate-limit';

const ALLOWED_AGENTSKILLS_HOSTS = new Set(['agentskills.io', 'www.agentskills.io', 'api.agentskills.io']);

// #6234: this is a top-level Vercel Edge Function (an api-route-exceptions
// entry, not a gateway RPC), so `checkEndpointRateLimit` never fires for it.
// Read the budget from the registry and enforce it in-handler, keeping the
// registry the single source of truth for the audit script and the docs.
const RATE_LIMIT_SCOPE = '/api/skills/fetch-agentskills';
const RATE_LIMIT_POLICY = ENDPOINT_RATE_POLICIES[RATE_LIMIT_SCOPE];
if (!RATE_LIMIT_POLICY) {
  // Module-load failure — better to crash the function cold-start with a loud
  // message than to silently fall back to "no rate limit" if someone
  // accidentally deletes the registry entry (same guard as api/docs-mcp.ts).
  throw new Error(
    `[fetch-agentskills] missing ENDPOINT_RATE_POLICIES['${RATE_LIMIT_SCOPE}'] — see server/_shared/rate-limit.ts`,
  );
}
const RATE_LIMIT_MAX = RATE_LIMIT_POLICY.limit;
const RATE_LIMIT_WINDOW = RATE_LIMIT_POLICY.window;

// Skill definitions are near-static, so an hour absorbs an import burst while
// still propagating an author's edit within the same session. The route is
// POST-only, so CDN caching is unavailable and Redis is the only option.
const CACHE_TTL_SECONDS = 3_600;
// Bounds both the Redis key length and the cache-key cardinality a caller can
// mint. agentskills.io skill URLs are an order of magnitude shorter.
const MAX_SKILL_URL_LENGTH = 512;

interface AgentSkillPayload {
  name: string;
  description: string;
  instructions: string;
  truncated: boolean;
}

export default async function handler(
  req: Request,
  ctx?: { waitUntil: (p: Promise<unknown>) => void },
): Promise<Response> {
  const corsHeaders = getCorsHeaders(req) as Record<string, string>;

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: { ...corsHeaders } });
  }

  if (req.method !== 'POST') {
    return Response.json({ error: 'Method not allowed' }, { status: 405, headers: corsHeaders });
  }

  // Metered before the body is read so a malformed payload is not a free
  // unlimited path to our edge. (#6234)
  // Redis-degraded scoped limits intentionally stay availability-first — the
  // upstream is a single public host behind a fixed three-entry allowlist and
  // the only caller is the settings skill importer, so degradation (logged by
  // checkScopedRateLimit) must not break skill import.
  const scoped = await checkScopedRateLimit(RATE_LIMIT_SCOPE, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW, getClientIp(req));
  if (!scoped.allowed) {
    const retryAfter = Math.max(1, Math.ceil((scoped.reset - Date.now()) / 1000));
    return Response.json({ error: 'Too many requests' }, {
      status: 429,
      headers: {
        ...corsHeaders,
        'X-RateLimit-Limit': String(scoped.limit),
        'X-RateLimit-Remaining': '0',
        'X-RateLimit-Reset': String(scoped.reset),
        'Retry-After': String(retryAfter),
      },
    });
  }

  let body: { url?: string; id?: string };
  try {
    body = await req.json() as { url?: string; id?: string };
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400, headers: corsHeaders });
  }

  const rawUrl = body.url ?? (body.id ? `https://agentskills.io/skills/${body.id}` : null);
  if (!rawUrl) {
    return Response.json({ error: 'Provide url or id' }, { status: 400, headers: corsHeaders });
  }
  if (rawUrl.length > MAX_SKILL_URL_LENGTH) {
    return Response.json({ error: 'URL too long' }, { status: 400, headers: corsHeaders });
  }

  let skillUrl: URL;
  try {
    skillUrl = new URL(rawUrl);
  } catch {
    return Response.json({ error: 'Invalid URL' }, { status: 400, headers: corsHeaders });
  }

  if (!ALLOWED_AGENTSKILLS_HOSTS.has(skillUrl.hostname)) {
    return Response.json({ error: 'Only agentskills.io URLs are supported.' }, { status: 400, headers: corsHeaders });
  }

  // Keyed after the allowlist check so an unapproved host can never mint a
  // cache key. Readable rather than hashed (same choice as api/symbol-search)
  // so the key is debuggable from the Redis side. A cache read failure is a
  // miss, never an error: the upstream fetch below is the source of truth.
  const cacheKey = `agentskills:v1:${skillUrl.hostname}${skillUrl.pathname}${skillUrl.search}`;
  try {
    const cached = await readJsonFromUpstash<AgentSkillPayload>(cacheKey, 1_500);
    if (cached) return Response.json(cached, { headers: corsHeaders });
  } catch { /* cache unavailable — fall through to the upstream fetch */ }

  let skillData: Record<string, unknown>;
  try {
    const res = await fetch(skillUrl.toString(), {
      headers: { 'Accept': 'application/json', 'User-Agent': 'WorldMonitor/1.0' },
      redirect: 'manual',
      signal: AbortSignal.timeout(8_000),
    });
    if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) {
      return Response.json({ error: 'Redirects are not allowed.' }, { status: 400, headers: corsHeaders });
    }
    if (!res.ok) {
      return Response.json({ error: 'Could not reach agentskills.io. Check your connection.' }, { status: 502, headers: corsHeaders });
    }
    skillData = await res.json() as Record<string, unknown>;
  } catch {
    return Response.json({ error: 'Could not reach agentskills.io. Check your connection.' }, { status: 502, headers: corsHeaders });
  }

  const instructions = typeof skillData.instructions === 'string' ? skillData.instructions : null;
  if (!instructions) {
    return Response.json({ error: "This skill has no instructions — it may use tools only (not supported)." }, { status: 422, headers: corsHeaders });
  }

  const MAX_LEN = 2000;
  const truncated = instructions.length > MAX_LEN;
  const name = typeof skillData.name === 'string' ? skillData.name : 'Imported Skill';
  const description = typeof skillData.description === 'string' ? skillData.description : '';

  const payload: AgentSkillPayload = {
    name,
    description,
    instructions: truncated ? instructions.slice(0, MAX_LEN) : instructions,
    truncated,
  };

  // Fire-and-forget write — never block the response on the cache fill. Use
  // ctx.waitUntil when Vercel provides it (keeps the function alive until the
  // SET completes); fall back to bare `void` for environments (tests, local
  // invokes) that don't pass ctx. Only the 200 payload is cached: the 422
  // "no instructions" outcome is left uncached deliberately, since negative
  // caching would need its own shape discriminator.
  const writePromise = setCachedData(cacheKey, payload, CACHE_TTL_SECONDS).catch(() => false);
  if (ctx) ctx.waitUntil(writePromise);
  else void writePromise;

  return Response.json(payload, { headers: corsHeaders });
}
