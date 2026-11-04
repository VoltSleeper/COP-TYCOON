import { createClient } from "npm:@supabase/supabase-js@2";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const adminPassword = Deno.env.get("COP_ADMIN_PASSWORD") ?? "";

const db = createClient(supabaseUrl, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cop-admin-session",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Cache-Control": "no-store",
};

function respond(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sameSecret(candidate: string, expected: string): Promise<boolean> {
  const [a, b] = await Promise.all([sha256(candidate), sha256(expected)]);
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}

function newSessionToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

async function getIpFingerprint(req: Request): Promise<string> {
  const ip = req.headers.get("cf-connecting-ip")
    ?? req.headers.get("x-real-ip")
    ?? req.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    ?? "unknown";
  return sha256(ip);
}

function validId(value: unknown): number | null {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function boundedText(value: unknown, max: number, field: string): string {
  if (typeof value !== "string" || value.length > max) throw new Error("Invalid " + field);
  return value;
}

function validateHistoryFields(input: Record<string, unknown>, requireAll: boolean) {
  const result: Record<string, unknown> = {};
  const textFields: Record<string, number> = {
    country: 120, sender: 120, receiver: 160, title: 300, reason: 1200, time: 40,
  };

  for (const [field, max] of Object.entries(textFields)) {
    if (Object.hasOwn(input, field)) result[field] = boundedText(input[field], max, field);
    else if (requireAll && ["country", "sender", "receiver", "title", "reason", "time"].includes(field)) {
      throw new Error("Missing " + field);
    }
  }

  if (Object.hasOwn(input, "amount")) {
    const amount = Number(input.amount);
    if (!Number.isFinite(amount) || amount <= 0 || amount > 9e15) throw new Error("Invalid amount");
    result.amount = amount;
  } else if (requireAll) throw new Error("Missing amount");

  if (Object.hasOwn(input, "reversed")) {
    if (typeof input.reversed !== "boolean") throw new Error("Invalid reversed flag");
    result.reversed = input.reversed;
  } else if (requireAll) result.reversed = false;

  return result;
}

async function checkAdminSession(req: Request): Promise<string | null> {
  const rawToken = req.headers.get("x-cop-admin-session") ?? "";
  if (rawToken.length < 40 || rawToken.length > 200) return null;
  const tokenHash = await sha256(rawToken);
  const { data, error } = await db
    .from("cop_admin_sessions")
    .select("token_hash,expires_at")
    .eq("token_hash", tokenHash)
    .maybeSingle();

  if (error || !data) return null;
  if (new Date(data.expires_at).getTime() <= Date.now()) {
    await db.from("cop_admin_sessions").delete().eq("token_hash", tokenHash);
    return null;
  }

  await db.from("cop_admin_sessions")
    .update({ last_used_at: new Date().toISOString() })
    .eq("token_hash", tokenHash);

  return tokenHash;
}

// verify_jwt is disabled for this function because it authenticates its own
// password login and short-lived admin-session token. Do not remove these checks.
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return respond({ ok: false, error: "Method not allowed" }, 405);

  try {
    const body = await req.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return respond({ ok: false, error: "Invalid request" }, 400);
    }

    const action = body.action;

    if (action === "login") {
      if (!adminPassword || adminPassword.length < 16) {
        return respond({ ok: false, error: "Admin access is not configured" }, 503);
      }
      if (typeof body.password !== "string" || body.password.length > 256) {
        return respond({ ok: false, error: "Invalid credentials" }, 401);
      }

      const fingerprint = await getIpFingerprint(req);
      const { data: rateData, error: rateError } = await db.rpc("cop_admin_login_allowed", {
        p_fingerprint_hash: fingerprint,
      });
      if (rateError) return respond({ ok: false, error: "Login temporarily unavailable" }, 503);
      const rate = Array.isArray(rateData) ? rateData[0] : rateData;
      if (!rate?.allowed) {
        return respond({ ok: false, error: "Too many attempts", retryAfter: rate?.retry_after_seconds ?? 900 }, 429);
      }

      if (!(await sameSecret(body.password, adminPassword))) {
        await db.rpc("cop_admin_login_failure", { p_fingerprint_hash: fingerprint });
        return respond({ ok: false, error: "Invalid credentials" }, 401);
      }

      await db.from("cop_admin_login_attempts").delete().eq("fingerprint_hash", fingerprint);
      await db.from("cop_admin_sessions").delete().lt("expires_at", new Date().toISOString());

      const sessionToken = newSessionToken();
      const tokenHash = await sha256(sessionToken);
      const expiresAt = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString();
      const { error: insertError } = await db.from("cop_admin_sessions").insert({
        token_hash: tokenHash,
        expires_at: expiresAt,
      });
      if (insertError) return respond({ ok: false, error: "Could not create admin session" }, 503);

      return respond({ ok: true, sessionToken, expiresAt });
    }

    if (action === "logout") {
      const rawToken = req.headers.get("x-cop-admin-session") ?? "";
      if (rawToken) {
        const tokenHash = await sha256(rawToken);
        await db.from("cop_admin_sessions").delete().eq("token_hash", tokenHash);
      }
      return respond({ ok: true });
    }

    const tokenHash = await checkAdminSession(req);
    if (!tokenHash) return respond({ ok: false, error: "Admin session expired" }, 401);

    if (action === "insert") {
      const record = body.record;
      if (!record || typeof record !== "object" || Array.isArray(record)) {
        return respond({ ok: false, error: "Invalid record" }, 400);
      }
      const id = validId(record.id);
      if (id === null) return respond({ ok: false, error: "Invalid id" }, 400);
      const values = validateHistoryFields(record, true);
      const { error } = await db.from("cop_history").insert({ id, ...values });
      if (error) return respond({ ok: false, error: "Could not insert history record" }, 400);
      return respond({ ok: true, id });
    }

    if (action === "update") {
      const id = validId(body.id);
      if (id === null || !body.patch || typeof body.patch !== "object" || Array.isArray(body.patch)) {
        return respond({ ok: false, error: "Invalid update" }, 400);
      }
      const values = validateHistoryFields(body.patch, false);
      if (Object.keys(values).length === 0) return respond({ ok: false, error: "Empty update" }, 400);
      const { data, error } = await db.from("cop_history").update(values).eq("id", id).select("id").maybeSingle();
      if (error || !data) return respond({ ok: false, error: "Could not update history record" }, 400);
      return respond({ ok: true, id });
    }

    if (action === "delete") {
      const id = validId(body.id);
      if (id === null) return respond({ ok: false, error: "Invalid id" }, 400);
      const { data, error } = await db.from("cop_history").delete().eq("id", id).select("id").maybeSingle();
      if (error || !data) return respond({ ok: false, error: "Could not delete history record" }, 400);
      return respond({ ok: true, id });
    }

    return respond({ ok: false, error: "Unknown action" }, 400);
  } catch (_error) {
    return respond({ ok: false, error: "Unexpected server error" }, 500);
  }
});
