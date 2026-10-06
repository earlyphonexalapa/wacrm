import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// --- Scenario knobs the mock reads -----------------------------------------
// `mockUser`         — what getUser() resolves to (a refreshed session ⇒ user,
//                      or null for the logged-out path).
// `refreshedCookies` — cookies Supabase writes via setAll() during getUser(),
//                      i.e. the freshly *rotated* auth token. The whole point
//                      of the test is that these must survive onto whatever
//                      response the middleware returns — including redirects.
let mockUser: {
  id: string;
  factors?: { factor_type: string; status: string }[];
} | null = null;
// Access token getSession() returns (carries the session_id claim the 2FA
// gate cookie is bound to).
let mockAccessToken: string | null = null;
let refreshedCookies: Array<{
  name: string;
  value: string;
  options: Record<string, unknown>;
}> = [];

vi.mock("@supabase/ssr", () => ({
  createServerClient: (
    _url: string,
    _key: string,
    opts: {
      cookies: { setAll: (c: typeof refreshedCookies) => void };
    },
  ) => ({
    auth: {
      // Mirrors real auth-js: an expired access token is transparently
      // refreshed inside getUser(), which rotates the refresh token and
      // pushes the new cookies through setAll() before resolving.
      getUser: async () => {
        if (refreshedCookies.length) opts.cookies.setAll(refreshedCookies);
        return { data: { user: mockUser } };
      },
      getSession: async () => ({
        data: { session: mockAccessToken ? { access_token: mockAccessToken } : null },
      }),
    },
  }),
}));

// Imported after the mock is registered.
const { middleware } = await import("./middleware");

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://test.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key";
  mockUser = null;
  mockAccessToken = null;
  refreshedCookies = [];
  delete process.env.ENCRYPTION_KEY;
  delete process.env.REQUIRE_2FA;
  delete process.env.DISABLE_2FA_GATE;
});

afterEach(() => vi.clearAllMocks());

const ROTATED = {
  name: "sb-test-auth-token",
  value: "rotated-refresh-token",
  options: { path: "/", httpOnly: true },
};

describe("middleware — refreshed auth cookies survive redirects", () => {
  it("carries the rotated token when redirecting a signed-in user off /login", async () => {
    mockUser = { id: "user-1" };
    refreshedCookies = [ROTATED];

    const res = await middleware(
      new NextRequest("https://app.test/login"),
    );

    // Redirect to /dashboard…
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/dashboard");
    // …and the rotated cookie MUST ride along, otherwise the browser keeps
    // replaying the now-consumed refresh token and the session wedges until
    // the user manually clears cookies.
    expect(res.cookies.get(ROTATED.name)?.value).toBe(ROTATED.value);
  });

  it("carries the rotated token when redirecting an unauth user to /login", async () => {
    mockUser = null;
    // Even on the logged-out path getUser() may emit cookie writes (e.g.
    // clearing a dead session); those must not be dropped on the redirect.
    refreshedCookies = [{ ...ROTATED, value: "cleared" }];

    const res = await middleware(
      new NextRequest("https://app.test/dashboard"),
    );

    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/login");
    expect(res.cookies.get(ROTATED.name)?.value).toBe("cleared");
  });

  it("redirects a signed-in user with an invite token to /join/<token>", async () => {
    mockUser = { id: "user-1" };
    refreshedCookies = [ROTATED];

    const res = await middleware(
      new NextRequest("https://app.test/login?invite=abc123"),
    );

    expect(res.headers.get("location")).toContain("/join/abc123");
    expect(res.cookies.get(ROTATED.name)?.value).toBe(ROTATED.value);
  });

  it("passes through (no redirect) for a signed-in user on a protected page", async () => {
    mockUser = { id: "user-1" };
    refreshedCookies = [ROTATED];

    const res = await middleware(
      new NextRequest("https://app.test/dashboard"),
    );

    // No redirect — the normal NextResponse.next() already carries cookies.
    expect(res.headers.get("location")).toBeNull();
    expect(res.cookies.get(ROTATED.name)?.value).toBe(ROTATED.value);
  });
});

// ---------------------------------------------------------------------------
// Two-step verification gate
// ---------------------------------------------------------------------------

const { signGateCookie, MFA_COOKIE } = await import("@/lib/auth/mfa-gate");

const SECRET = "c".repeat(64);
const SESSION_ID = "session-abc";
const b64 = (o: object) =>
  btoa(JSON.stringify(o)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
const accessToken = `${b64({ alg: "HS256" })}.${b64({ session_id: SESSION_ID })}.sig`;

const WITH_TOTP = {
  id: "user-1",
  factors: [{ factor_type: "totp", status: "verified" }],
};

function req(path: string, cookie?: string) {
  return new NextRequest(`https://app.test${path}`, {
    headers: cookie ? { cookie: `${MFA_COOKIE}=${cookie}` } : undefined,
  });
}

describe("middleware — two-step verification gate", () => {
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = SECRET;
    mockAccessToken = accessToken;
  });

  it("sends a user with an authenticator to /2fa when this browser hasn't verified", async () => {
    mockUser = WITH_TOTP;
    const res = await middleware(req("/inbox?c=9"));
    expect(res.status).toBe(307);
    const location = new URL(res.headers.get("location")!);
    expect(location.pathname).toBe("/2fa");
    expect(location.searchParams.get("next")).toBe("/inbox?c=9");
    expect(location.searchParams.get("setup")).toBeNull();
  });

  it("answers an API call with 401 mfa_required instead of redirecting", async () => {
    mockUser = WITH_TOTP;
    const res = await middleware(req("/api/whatsapp/send"));
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: "mfa_required" });
  });

  it("lets a verified browser through", async () => {
    mockUser = WITH_TOTP;
    const cookie = await signGateCookie({ userId: "user-1", sessionId: SESSION_ID, secret: SECRET });
    const res = await middleware(req("/inbox", cookie));
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
  });

  it("asks again after signing in a new session", async () => {
    mockUser = WITH_TOTP;
    const cookie = await signGateCookie({ userId: "user-1", sessionId: "an-older-session", secret: SECRET });
    const res = await middleware(req("/inbox", cookie));
    expect(res.status).toBe(307);
  });

  it("doesn't touch someone who has no authenticator", async () => {
    mockUser = { id: "user-2" };
    const res = await middleware(req("/inbox"));
    expect(res.status).toBe(200);
  });

  it("never blocks the verification page itself or the webhook", async () => {
    mockUser = WITH_TOTP;
    expect((await middleware(req("/2fa"))).status).toBe(200);
    expect((await middleware(req("/api/auth/2fa/verify"))).status).toBe(200);
    expect((await middleware(req("/api/whatsapp/webhook"))).status).toBe(200);
  });

  it("with REQUIRE_2FA, sends someone with no authenticator to set one up", async () => {
    process.env.REQUIRE_2FA = "1";
    mockUser = { id: "user-2" };
    const res = await middleware(req("/dashboard"));
    expect(res.status).toBe(307);
    const location = new URL(res.headers.get("location")!);
    expect(location.pathname).toBe("/2fa");
    expect(location.searchParams.get("setup")).toBe("1");
  });

  it("DISABLE_2FA_GATE is the emergency off switch", async () => {
    process.env.DISABLE_2FA_GATE = "1";
    mockUser = WITH_TOTP;
    expect((await middleware(req("/inbox"))).status).toBe(200);
  });

  it("is off when there is no server secret to sign with", async () => {
    delete process.env.ENCRYPTION_KEY;
    mockUser = WITH_TOTP;
    expect((await middleware(req("/inbox"))).status).toBe(200);
  });

  it("keeps the refreshed auth cookies on the 2FA redirect", async () => {
    mockUser = WITH_TOTP;
    refreshedCookies = [ROTATED];
    const res = await middleware(req("/inbox"));
    expect(res.status).toBe(307);
    expect(res.cookies.get(ROTATED.name)?.value).toBe(ROTATED.value);
  });
});
