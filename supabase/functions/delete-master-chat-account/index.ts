import { createSupabaseContext } from "npm:@supabase/server";

const allowedOrigin = (origin: string | null) => {
  if (!origin) return true;
  if (origin === "https://windows-12-beta.vercel.app") return true;
  if (/^https:\/\/windows-12-beta-[a-z0-9-]+\.vercel\.app$/i.test(origin)) return true;
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
  if (!allowedOrigin(origin)) return json({ error: "origin_not_allowed" }, 403, origin);
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(origin) });
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405, origin);

  let payload: { confirmation?: unknown };
  try {
    payload = await request.json();
  } catch {
    return json({ error: "invalid_request" }, 400, origin);
  }
  if (payload?.confirmation !== "DELETE") {
    return json({ error: "confirmation_required" }, 400, origin);
  }

  // The Edge Function validates the user's JWT. No client-provided user ID is accepted.
  const { data: context, error: contextError } = await createSupabaseContext(request, { auth: "user" });
  if (contextError || !context) {
    return json({ error: "authentication_required" }, 401, origin);
  }

  try {
    const { data: userResult, error: userError } = await context.supabase.auth.getUser();
    const user = userResult?.user;
    if (userError || !user?.id) return json({ error: "authentication_required" }, 401, origin);

    // Restrict this destructive endpoint to accounts that have a Master Chat profile.
    // The admin client is server-only and is never returned to the browser.
    const { data: profile, error: profileError } = await context.supabaseAdmin
      .from("aeroshell_profiles")
      .select("id")
      .eq("id", user.id)
      .maybeSingle();

    if (profileError) {
      console.error("Master Chat deletion profile lookup failed", profileError.code);
      return json({ error: "account_deletion_failed" }, 500, origin);
    }
    if (!profile) return json({ error: "account_profile_not_found" }, 404, origin);

    const { error: deleteError } = await context.supabaseAdmin.auth.admin.deleteUser(user.id, false);
    if (deleteError) {
      console.error("Master Chat deletion failed", deleteError.message);
      return json({ error: "account_deletion_failed" }, 500, origin);
    }

    // The profile and related chat records cascade from auth.users. A database guard
    // also rejects still-unexpired JWTs whose user has just been deleted.
    return json({ success: true }, 200, origin);
  } catch (error) {
    console.error("Master Chat deletion request failed", error instanceof Error ? error.message : "unknown error");
    return json({ error: "account_deletion_failed" }, 500, origin);
  }
});
