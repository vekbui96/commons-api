/**
 * The security contract (docs/api-contract.md, "Security"):
 *
 * - Origins: a request whose Origin is present and not allowed is refused, on
 *   every /api path. Allowed cross-origin requests get CORS headers; a preflight
 *   from the Pages origin that asks for Private Network Access gets
 *   `Access-Control-Allow-Private-Network: true`.
 * - Identity: `tailscale serve` sets Tailscale-User-Login (and overwrites any
 *   copy the client sends). The API trusts it only because it listens on
 *   127.0.0.1, and in production only when the TCP peer is the Tailscale
 *   service (peer check, same as the hub's action server). /api/session and
 *   /api/apps/* need the owner's login; /api/health needs nothing.
 * - Not from server-pc itself: serve adds the owner's login to requests made
 *   from this box through the tailnet too, so a request whose X-Forwarded-For
 *   is one of this node's tailnet IPs (or missing) is refused, as the hub does.
 * - Writes (POST/PUT/PATCH/DELETE) need an allowed Origin and the per-boot CSRF
 *   token from GET /api/session in X-Commons-Token.
 */
import crypto from "node:crypto";
import type { Socket } from "node:net";
import type { NextFunction, Request, RequestHandler, Response } from "express";

export const TOKEN_HEADER = "X-Commons-Token";
const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export interface PeerVerdict {
  ok: boolean;
  why?: string;
}
export type PeerCheck = (socket: Socket) => Promise<PeerVerdict>;

/**
 * Mutable on purpose: production fills ownerLogin and selfIps in once
 * `tailscale status` answers (identity routes answer 503 until then).
 */
export interface SecurityConfig {
  /** Browser origins allowed at all (exact strings or patterns). */
  allowedOrigins: (string | RegExp)[];
  /** Cross-origin preflights from these get Access-Control-Allow-Private-Network. */
  privateNetworkOrigins: string[];
  /** The tailnet login of the owner; null until known. Compared case-insensitively. */
  ownerLogin: string | null;
  /** Required Host header on identity routes (the 8445 name); null = no check. */
  publicHost: string | null;
  /** This node's tailnet IPs: requests forwarded from them are refused. */
  selfIps: string[];
  /** In production: the TCP peer must be tailscaled. Omitted = no peer check (dev, tests). */
  peerCheck?: PeerCheck;
  /** Per-boot CSRF token handed out by GET /api/session. */
  csrfToken: string;
}

export function newCsrfToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

export function originAllowed(origin: string, allowed: (string | RegExp)[]): boolean {
  return allowed.some((rule) => (typeof rule === "string" ? rule === origin : rule.test(origin)));
}

function refuse(res: Response, status: number, error: string) {
  res.status(status).set("Cache-Control", "no-store").json({ error });
}

function header(req: Request, name: string): string | undefined {
  const value = req.headers[name.toLowerCase()];
  return typeof value === "string" ? value : undefined;
}

function tokenMatches(given: string | undefined, token: string): boolean {
  if (!given || !token) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * First on /api: refuses a disallowed Origin, sets CORS headers for an allowed
 * one and answers preflights (before any identity check: preflights carry none).
 */
export function originGuard(sec: SecurityConfig): RequestHandler {
  return (req, res, next) => {
    res.vary("Origin");
    const origin = header(req, "origin");
    if (origin === undefined) return next();
    if (!originAllowed(origin, sec.allowedOrigins)) return refuse(res, 403, "origin_not_allowed");
    res.set("Access-Control-Allow-Origin", origin);
    if (req.method === "OPTIONS" && header(req, "access-control-request-method")) {
      res.set({
        "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE",
        "Access-Control-Allow-Headers": `Content-Type, ${TOKEN_HEADER}`,
        "Access-Control-Max-Age": "600",
      });
      if (
        header(req, "access-control-request-private-network") === "true" &&
        sec.privateNetworkOrigins.includes(origin)
      ) {
        res.set("Access-Control-Allow-Private-Network", "true");
      }
      res.status(204).end();
      return;
    }
    next();
  };
}

/** The owner's identity, from tailscale serve, through the checks above. */
export function requireOwner(sec: SecurityConfig): RequestHandler {
  return (req, res, next) => {
    void checkOwner(sec, req).then(
      (failure) => (failure ? refuse(res, failure.status, failure.error) : next()),
      next,
    );
  };
}

async function checkOwner(
  sec: SecurityConfig,
  req: Request,
): Promise<{ status: number; error: string } | null> {
  if (!sec.ownerLogin) return { status: 503, error: "identity_not_ready" };
  if (sec.peerCheck) {
    const peer = await sec.peerCheck(req.socket);
    if (!peer.ok) return { status: 403, error: "not_via_tailscale" };
  }
  const login = header(req, "tailscale-user-login");
  if (!login) return { status: 401, error: "identity_required" };
  if (sec.publicHost && header(req, "host") !== sec.publicHost) return { status: 403, error: "wrong_host" };
  if (login.toLowerCase() !== sec.ownerLogin.toLowerCase()) return { status: 403, error: "not_owner" };
  const from = (header(req, "x-forwarded-for") ?? "").split(",")[0]!.trim();
  if (!from || sec.selfIps.includes(from)) return { status: 403, error: "self_request" };
  return null;
}

/** On identity routes: writes need an allowed Origin and the CSRF token. */
export function requireCsrf(sec: SecurityConfig): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!WRITE_METHODS.has(req.method)) return next();
    const origin = header(req, "origin");
    if (!origin || !originAllowed(origin, sec.allowedOrigins)) return refuse(res, 403, "origin_required");
    if (!tokenMatches(header(req, TOKEN_HEADER), sec.csrfToken))
      return refuse(res, 403, "csrf_token_invalid");
    next();
  };
}
