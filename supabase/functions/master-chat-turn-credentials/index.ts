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

  const { data: userData, error: userError } = await supabase.auth.getUser();
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

  // The user-scoped client and database RLS enforce participant membership. No service-role key is used.
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

  // A server-enforced per-user quota limits repeated TURN credential minting.
  const { error: quotaError } = await supabase.from("aeroshell_turn_credential_requests")
    .insert({ user_id: userData.user.id, call_id: callId });
  if (quotaError) {
    const rateLimited = quotaError.code === "54000" || /too many relay credential requests/i.test(quotaError.message);
    return json({ error: rateLimited ? "rate_limited" : "relay_authorization_failed" }, rateLimited ? 429 : 503, origin);
  }

  const turnKeyId = Deno.env.get("CLOUDFLARE_TURN_KEY_ID");
  const turnApiToken = Deno.env.get("CLOUDFLARE_TURN_API_TOKEN");
  if (!turnKeyId || !turnApiToken) return json({ error: "private_relay_not_configured" }, 503, origin);

  try {
    // Cloudflare's long-lived TURN key and API token stay server-side. Only short-lived
    // credentials (one-hour TTL) are returned to an authenticated participant in an active call.
    const upstream = await fetch(
      "https://rtc.live.cloudflare.com/v1/turn/keys/" + encodeURIComponent(turnKeyId) + "/credentials/generate-ice-servers",
      {
        method: "POST",
        headers: {
          "Authorization": "Bearer " + turnApiToken,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ttl: 3600 }),
        signal: AbortSignal.timeout(8000),
      },
    );
    if (!upstream.ok) {
      // Never echo upstream body or credentials to the browser.
      return json({ error: "private_relay_unavailable" }, 502, origin);
    }
    const payload = await upstream.json() as { iceServers?: Array<{ urls?: string | string[]; username?: string; credential?: string }> };
    const iceServers = (payload.iceServers ?? []).filter(server => {
      const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
      return typeof server.username === "string" && typeof server.credential === "string"
        && urls.some(url => typeof url === "string" && /^turns?:turn\.cloudflare\.com:/i.test(url));
    });
    if (!iceServers.length) return json({ error: "private_relay_unavailable" }, 502, origin);
    return json({ iceServers, expiresInSeconds: 3600 }, 200, origin);
  } catch {
    return json({ error: "private_relay_unavailable" }, 502, origin);
  }
});
