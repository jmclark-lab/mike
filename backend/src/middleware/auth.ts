import { Request, Response, NextFunction } from "express";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { timingSafeEqual } from "node:crypto";

const isDev = process.env.NODE_ENV !== "production";
const devLog = (...args: Parameters<typeof console.log>) => {
  if (isDev) console.log(...args);
};

function summarizeMfaFactors(
  factors:
    | Array<{
        factor_type?: string;
        status?: string;
      }>
    | null
    | undefined,
) {
  return (factors ?? []).map((factor) => ({
    type: factor.factor_type ?? "unknown",
    status: factor.status ?? "unknown",
  }));
}

function isLoginMfaBootstrapRoute(req: Request) {
  const path = req.originalUrl.split("?")[0];
  return (
    (req.method === "GET" || req.method === "POST") &&
    (path === "/user/profile" || path === "/users/profile")
  );
}

async function enforceLoginMfaIfEnabled(
  req: Request,
  res: Response,
  admin: SupabaseClient<any, "public", any>,
  token: string,
) {
  if (isLoginMfaBootstrapRoute(req)) return true;

  const { data, error } = await admin
    .from("user_profiles")
    .select("mfa_on_login")
    .eq("user_id", res.locals.userId)
    .maybeSingle();

  if (error) {
    devLog("[auth/mfa] login preference lookup failed", {
      method: req.method,
      path: req.originalUrl,
      userId: res.locals.userId,
      error: error.message,
      code: error.code,
    });
    if (error.code === "42703") return true;
    res.status(500).json({ detail: error.message });
    return false;
  }

  const profile = data as { mfa_on_login?: boolean } | null;
  if (profile?.mfa_on_login !== true) return true;

  const { data: assurance, error: assuranceError } =
    await admin.auth.mfa.getAuthenticatorAssuranceLevel(token);

  if (assuranceError) {
    devLog("[auth/mfa] login assurance lookup failed", {
      method: req.method,
      path: req.originalUrl,
      userId: res.locals.userId,
      error: assuranceError.message,
    });
    res.status(401).json({ detail: assuranceError.message });
    return false;
  }

  if (assurance.nextLevel === "aal2" && assurance.currentLevel !== "aal2") {
    devLog("[auth/mfa] login verification required", {
      method: req.method,
      path: req.originalUrl,
      userId: res.locals.userId,
    });
    res.status(403).json({
      code: "mfa_verification_required",
      detail: "MFA verification required",
    });
    return false;
  }

  return true;
}

export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const auth = req.headers.authorization ?? "";
  if (!auth.startsWith("Bearer ")) {
    res.status(401).json({ detail: "Missing or invalid Authorization header" });
    return;
  }
  const token = auth.slice(7).trim();

  const supabaseUrl = process.env.SUPABASE_URL ?? "";
  const serviceKey = process.env.SUPABASE_SECRET_KEY ?? "";

  if (!supabaseUrl || !serviceKey) {
    res.status(500).json({ detail: "Server auth is not configured" });
    return;
  }

  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false },
  });
  const { data } = await admin.auth.getUser(token);
  if (!data.user) {
    res.status(401).json({ detail: "Invalid or expired token" });
    return;
  }

  res.locals.userId = data.user.id;
  res.locals.userEmail = data.user.email?.toLowerCase() ?? "";
  res.locals.token = token;
  if (!(await enforceLoginMfaIfEnabled(req, res, admin, token))) {
    return;
  }
  next();
}

export async function requireMfaIfEnrolled(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const token = typeof res.locals.token === "string" ? res.locals.token : "";
  if (!token) {
    devLog("[auth/mfa] missing auth session", {
      method: req.method,
      path: req.originalUrl,
    });
    res.status(401).json({ detail: "Missing auth session" });
    return;
  }

  const supabaseUrl = process.env.SUPABASE_URL ?? "";
  const serviceKey = process.env.SUPABASE_SECRET_KEY ?? "";

  if (!supabaseUrl || !serviceKey) {
    res.status(500).json({ detail: "Server auth is not configured" });
    return;
  }

  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false },
  });
  const { data, error } =
    await admin.auth.mfa.getAuthenticatorAssuranceLevel(token);

  if (error) {
    devLog("[auth/mfa] assurance lookup failed", {
      method: req.method,
      path: req.originalUrl,
      userId: res.locals.userId,
      error: error.message,
    });
    res.status(401).json({ detail: error.message });
    return;
  }

  devLog("[auth/mfa] assurance level", {
    method: req.method,
    path: req.originalUrl,
    userId: res.locals.userId,
    currentLevel: data.currentLevel,
    nextLevel: data.nextLevel,
    required: data.nextLevel === "aal2" && data.currentLevel !== "aal2",
  });

  if (isDev) {
    const { data: userData, error: userError } =
      await admin.auth.getUser(token);
    devLog("[auth/mfa] user factors", {
      method: req.method,
      path: req.originalUrl,
      userId: res.locals.userId,
      factorCount: userData.user?.factors?.length ?? 0,
      factors: summarizeMfaFactors(userData.user?.factors),
      error: userError?.message ?? null,
    });
  }

  if (data.nextLevel === "aal2" && data.currentLevel !== "aal2") {
    devLog("[auth/mfa] verification required", {
      method: req.method,
      path: req.originalUrl,
      userId: res.locals.userId,
    });
    res.status(403).json({
      code: "mfa_verification_required",
      detail: "MFA verification required",
    });
    return;
  }

  next();
}

function safeKeyEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

// Service-to-service auth for the MCP connector. If a valid X-Connector-Key is
// presented, act as the configured service user and skip the Supabase user JWT
// and MFA. Active only when BOTH CONNECTOR_API_KEY and CONNECTOR_USER_ID env
// vars are set AND the header matches; otherwise it falls back to requireAuth,
// so human/JWT auth is completely unchanged. Intended for the chat endpoint.
export async function connectorOrAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const expectedKey = process.env.CONNECTOR_API_KEY?.trim();
  const serviceUserId = process.env.CONNECTOR_USER_ID?.trim();
  const header = req.headers["x-connector-key"];
  const provided = (Array.isArray(header) ? header[0] : header)?.trim() ?? "";
  if (
    expectedKey &&
    serviceUserId &&
    provided &&
    safeKeyEqual(provided, expectedKey)
  ) {
    res.locals.userId = serviceUserId;
    res.locals.userEmail = process.env.CONNECTOR_USER_EMAIL?.trim() ?? "";
    res.locals.token = "";
    next();
    return;
  }
  await requireAuth(req, res, next);
}

export function requireConnectorKey(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const expectedKey = process.env.CONNECTOR_API_KEY?.trim();
  const header = req.headers["x-connector-key"];
  const provided = (Array.isArray(header) ? header[0] : header)?.trim() ?? "";
  if (expectedKey && provided && safeKeyEqual(provided, expectedKey)) {
    next();
    return;
  }
  res.status(401).json({ detail: "Invalid connector credentials" });
}
