import { createClient } from "npm:@supabase/supabase-js@2";

const allowedOrigin = (origin: string | null) => {
  if (!origin) return true;
  if (origin === "https://windows-12-beta.vercel.app") return true;
  if (/^https:\/\/windows-12-beta-[a-z0-9-]+-vexel-ai\.vercel\.app$/i.test(origin)) return true;
  if (origin === "http://localhost:5173" || origin === "http://localhost:4173") return true;
  return false;
};

const corsHeaders = (origin: string | null): Record<string, string> => ({
  "Access-Control-Allow-Origin": origin && allowedOrigin(origin) ? origin : "https://windows-12-beta.vercel.app",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Vary": "Origin",
});

const json = (body: Record<string, unknown>, status: number, origin: string | null) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(origin), "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

Deno.serve(async (request: Request) => {
  const origin = request.headers.get("Origin");
  if (request.method === "OPTIONS") {
    if (!allowedOrigin(origin)) return json({ error: "origin_not_allowed" }, 403, origin);
    return new Response("ok", { headers: corsHeaders(origin) });
  }
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405, origin);
  if (!allowedOrigin(origin)) return json({ error: "origin_not_allowed" }, 403, origin);

  const authorization = request.headers.get("Authorization");
  if (!authorization?.startsWith("Bearer ")) return json({ error: "authentication_required" }, 401, origin);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const publishableKeysText = Deno.env.get("SUPABASE_PUBLISHABLE_KEYS");
  let publishableKey = Deno.env.get("SUPABASE_ANON_KEY");
  if (publishableKeysText) {
    try {
      const keys = JSON.parse(publishableKeysText) as Record<string, string>;
      publishableKey = keys.default ?? Object.values(keys)[0] ?? publishableKey;
    } catch {
      // Fall back only to the platform-provided legacy anon key.
    }
  }
  if (!supabaseUrl || !publishableKey) return json({ error: "backend_configuration_unavailable" }, 503, origin);

  const supabase = createClient(supabaseUrl, publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: authorization } },
  });

  // Validate the bearer token explicitly. Do not rely on a persisted SDK session
  // inside the Edge Function, where persistSession is intentionally disabled.
  const bearerToken = authorization.slice("Bearer ".length).trim();
  const { data: userData, error: userError } = await supabase.auth.getUser(bearerToken);
  if (userError || !userData.user) return json({ error: "invalid_session" }, 401, origin);

  let body: { callId?: unknown };
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid_request" }, 400, origin);
  }
  const callId = typeof body.callId === "string" ? body.callId : "";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(callId)) {
    return json({ error: "invalid_call_id" }, 400, origin);
  }

  // The user-scoped client and database RLS enforce participant membership.
  const { data: call, error: callError } = await supabase.from("aeroshell_calls")
    .select("id, caller_id, callee_id, status, created_at, updated_at")
    .eq("id", callId)
    .maybeSingle();
  if (callError || !call) return json({ error: "call_not_found_or_forbidden" }, 404, origin);
  if (call.caller_id !== userData.user.id && call.callee_id !== userData.user.id) {
    return json({ error: "call_not_found_or_forbidden" }, 404, origin);
  }
  if (call.status !== "ringing" && call.status !== "accepted") {
    return json({ error: "call_not_active" }, 409, origin);
  }
  if (call.status === "ringing" && Date.now() - new Date(call.created_at).getTime() > 45_000) {
    return json({ error: "call_expired" }, 409, origin);
  }

  // Keep provider configuration errors from consuming a user's relay request quota.
  const meteredDomain = Deno.env.get("METERED_TURN_DOMAIN")?.trim().toLowerCase() ?? "";
  const meteredApiKey = Deno.env.get("METERED_TURN_API_KEY")?.trim() ?? "";
  if (!meteredDomain || !meteredApiKey) {
    return json({ error: "private_relay_not_configured" }, 503, origin);
  }
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.metered\.live$/i.test(meteredDomain)) {
    return json({ error: "backend_configuration_unavailable" }, 503, origin);
  }

  // A server-enforced per-user quota limits repeated TURN credential requests.
  const { error: quotaError } = await supabase.from("aeroshell_turn_credential_requests")
    .insert({ user_id: userData.user.id, call_id: callId });
  if (quotaError) {
    const rateLimited = quotaError.code === "54000" || /too many relay credential requests/i.test(quotaError.message);
    return json({ error: rateLimited ? "rate_limited" : "relay_authorization_failed" }, rateLimited ? 429 : 503, origin);
  }

  try {
    const endpoint = new URL("https://" + meteredDomain + "/api/v1/turn/credentials");
    endpoint.searchParams.set("apiKey", meteredApiKey);
    endpoint.searchParams.set("region", "asia");
    const upstream = await fetch(endpoint, {
      method: "GET",
      headers: { "Accept": "application/json" },
      signal: AbortSignal.timeout(8000),
    });
    if (!upstream.ok) {
      // Never forward provider response bodies, which may contain diagnostic data.
      return json({ error: "private_relay_unavailable" }, 502, origin);
    }

    const payload = await upstream.json() as Array<{
      urls?: string | string[];
      username?: string;
      credential?: string;
    }>;
    const iceServers = (Array.isArray(payload) ? payload : []).flatMap(server => {
      const candidates = Array.isArray(server?.urls) ? server.urls : [server?.urls];
      const urls = candidates.filter((url): url is string =>
        typeof url === "string"
        && /^turns?:[a-z0-9.-]+\.relay\.metered\.ca:\d+(?:\?transport=(?:tcp|udp))?$/i.test(url.trim()),
      );
      if (!urls.length || typeof server?.username !== "string" || !server.username.trim()
        || typeof server?.credential !== "string" || !server.credential.trim()) return [];
      return [{ urls: urls.length === 1 ? urls[0] : urls, username: server.username, credential: server.credential }];
    });
    if (!iceServers.length) return json({ error: "private_relay_unavailable" }, 502, origin);
    return json({ iceServers }, 200, origin);
  } catch {
    return json({ error: "private_relay_unavailable" }, 502, origin);
  }
});
