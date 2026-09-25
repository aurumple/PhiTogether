// Self-hosted server client (see server/ in the repo root): session storage,
// login/register and an authFetch wrapper that transparently refreshes the
// access token on 401 — same semantics the rest of the client relies on.
const BASE = "/api";
const STORAGE_KEY = "ptServerSession";

export interface ServerUser {
    id: number;
    username: string;
    nickname: string;
    is_admin: boolean;
}

interface Session {
    access_token: string;
    refresh_token: string;
    user: ServerUser | null;
}

function loadSession(): Session | null {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (parsed && parsed.access_token && parsed.refresh_token) return parsed;
    } catch {
        /* corrupted session storage falls back to logged out */
    }
    return null;
}

function saveSession(session: Session | null) {
    if (session) localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
    else localStorage.removeItem(STORAGE_KEY);
}

let session: Session | null = loadSession();
let refreshPromise: Promise<boolean> | null = null;

export function currentUser(): ServerUser | null {
    return session?.user ?? null;
}

export function isLoggedIn(): boolean {
    return !!session?.access_token && !!session?.user;
}

export function getAccessToken(): string | null {
    return session?.access_token ?? null;
}

export function logout() {
    session = null;
    saveSession(null);
}

function authHeaders(options: RequestInit = {}, token?: string | null): RequestInit {
    const t = token === undefined ? getAccessToken() : token;
    return {
        ...options,
        headers: {
            ...((options.headers as Record<string, string>) || {}),
            ...(t ? { Authorization: `Bearer ${t}` } : {}),
        },
    };
}

async function request(path: string, options: RequestInit = {}, token?: string | null) {
    return fetch(path, authHeaders(options, token));
}

function describeError(detail: unknown): string {
    if (typeof detail === "string") return detail;
    if (Array.isArray(detail)) {
        const msgs = detail
            .map((e: any) => (e && typeof e === "object" && "msg" in e ? String(e.msg) : ""))
            .filter(Boolean);
        return msgs.length ? msgs.join("; ") : "Invalid request";
    }
    if (detail && typeof detail === "object") return JSON.stringify(detail);
    return detail == null ? "" : String(detail);
}

async function errorFromResponse(resp: Response): Promise<Error> {
    let message = resp.statusText || `Request failed (${resp.status})`;
    try {
        const payload = await resp.json();
        message = describeError((payload as any)?.detail) || message;
    } catch {
        /* non-JSON error body keeps the status text */
    }
    return new Error(message);
}

/** Refresh the access token; concurrent callers share one in-flight refresh. */
async function refreshTokens(): Promise<boolean> {
    if (!session?.refresh_token) return false;
    if (refreshPromise) return refreshPromise;
    refreshPromise = (async () => {
        try {
            const resp = await request(
                `${BASE}/auth/refresh`,
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ refresh_token: session!.refresh_token }),
                },
                null
            );
            if (!resp.ok) {
                logout();
                return false;
            }
            const data = await resp.json();
            session = {
                access_token: data.access_token,
                refresh_token: data.refresh_token,
                user: session!.user,
            };
            saveSession(session);
            return true;
        } catch {
            return false; // offline: keep the session for a later retry
        } finally {
            refreshPromise = null;
        }
    })();
    return refreshPromise;
}

/**
 * Fetch with the Authorization header attached; a 401 triggers one token
 * refresh and a retry before giving up.
 */
export async function authFetch(path: string, options: RequestInit = {}): Promise<Response> {
    let response = await request(path, options);
    if (response.status !== 401 || !session?.refresh_token) return response;
    if (!(await refreshTokens())) return response;
    return request(path, options);
}

export async function fetchMe(): Promise<ServerUser | null> {
    try {
        const resp = await authFetch(`${BASE}/auth/me`);
        if (!resp.ok) return null;
        return (await resp.json()) as ServerUser;
    } catch {
        return null;
    }
}

export async function login(username: string, password: string): Promise<ServerUser> {
    const resp = await request(
        `${BASE}/auth/login`,
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ username, password }),
        },
        null
    );
    if (!resp.ok) throw await errorFromResponse(resp);
    const data = await resp.json();
    session = {
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        user: null,
    };
    saveSession(session);
    const user = await fetchMe();
    if (!user) {
        logout();
        throw new Error("Failed to load user profile");
    }
    session!.user = user;
    saveSession(session);
    return user;
}

export interface RegisterInput {
    username: string;
    password: string;
    confirm_password: string;
    nickname?: string;
}

export async function register(input: RegisterInput): Promise<ServerUser> {
    const resp = await request(
        `${BASE}/auth/register`,
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(input),
        },
        null
    );
    if (!resp.ok) throw await errorFromResponse(resp);
    return login(input.username, input.password);
}

/**
 * Resume a stored session at startup: refresh the token and re-read /me.
 * Returns the user on success, null when logged out or fully offline (in the
 * offline case the stored session is kept so a later retry can succeed).
 */
export async function restoreSession(): Promise<ServerUser | null> {
    if (!session?.refresh_token) return null;
    if (!(await refreshTokens())) {
        return session ? session.user : null;
    }
    const user = await fetchMe();
    if (user) {
        session!.user = user;
        saveSession(session);
    }
    return user;
}
