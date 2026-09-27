// Self-hosted server client (see server/ in the repo root): session storage,
// login/register and an authFetch wrapper that transparently refreshes the
// access token on 401 — same semantics the rest of the client relies on.
//
// 模块模式（window.__onetapPlatform 存在）不走 JWT：身份由宿主绑定，经
// api.game.call('game.profile') 取显示名/统计（幂等、失败视为未登录），
// localStorage 一律不读不写；独立版的 JWT 路径原样保留。
const BASE = "/api";
const STORAGE_KEY = "ptServerSession";

export interface ServerUser {
    id: number;
    username: string;
    nickname: string;
    is_admin: boolean;
}

function platform(): any {
    return (typeof window !== "undefined" && (window as any).__onetapPlatform) || null;
}

/** 模块模式的宿主 SDK（api.game/api.blobs/…）；独立版返回 null。 */
export function moduleApi(): any {
    const p = platform();
    return p && p.api ? p.api : null;
}

/** 模块模式谱面包下载地址约定：/api/game/charts/<contentId>（contentId 与网关内容 ID 一致）。 */
export function moduleContentIdOf(filePath: string): string {
    return decodeURIComponent(String(filePath).split("?")[0].split("/").pop() || "");
}

/** game.profile 结果 → 本地 ServerUser 视图（缺字段按未登录处理）。 */
function userFromProfile(profile: any): ServerUser | null {
    if (!profile || typeof profile !== "object") return null;
    const name = profile.displayName || profile.nickname || profile.username || profile.name;
    if (!name) return null;
    return {
        id: typeof profile.id === "number" ? profile.id : 0,
        username: String(profile.username || name),
        nickname: String(profile.nickname || name),
        is_admin: profile.isAdmin === true || profile.is_admin === true,
    };
}

let moduleProfileCache: any = null;
let moduleProfileInflight: Promise<any> | null = null;

/** 模块模式的身份/统计：成功缓存、失败不缓存（下次调用重试），并发共享同一次调用。 */
export function moduleProfile(): Promise<any | null> {
    const p = platform();
    if (!p || !p.api || !p.api.game) return Promise.resolve(null);
    if (moduleProfileCache !== null) return Promise.resolve(moduleProfileCache);
    if (moduleProfileInflight) return moduleProfileInflight;
    moduleProfileInflight = Promise.resolve()
        .then(() => p.api.game.call("game.profile"))
        .then((result: any) => {
            moduleProfileCache = result || null;
            return moduleProfileCache;
        })
        .catch(() => null)
        .finally(() => {
            moduleProfileInflight = null;
        });
    return moduleProfileInflight;
}

/** 模块模式的显示名/统计视图（同步）：prepare() 已缓存 identity，挂载前即可用。 */
function moduleUser(): ServerUser | null {
    const p = platform();
    if (!p) return null;
    return userFromProfile(moduleProfileCache ?? p.identity);
}

interface Session {
    access_token: string;
    refresh_token: string;
    user: ServerUser | null;
}

function loadSession(): Session | null {
    if (platform()) return null; // 模块模式无 JWT，身份由宿主绑定
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
    if (platform()) return; // 模块模式不持久化令牌
    if (session) localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
    else localStorage.removeItem(STORAGE_KEY);
}

let session: Session | null = loadSession();
let refreshPromise: Promise<boolean> | null = null;

export function currentUser(): ServerUser | null {
    if (platform()) return moduleUser();
    return session?.user ?? null;
}

export function isLoggedIn(): boolean {
    if (platform()) return !!moduleUser();
    return !!session?.access_token && !!session?.user;
}

export function getAccessToken(): string | null {
    if (platform()) return null;
    return session?.access_token ?? null;
}

export function logout() {
    if (platform()) {
        // 模块模式没有服务端登出：清掉本地身份缓存即可（账号切换由宿主负责）
        moduleProfileCache = null;
        return;
    }
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
    const controller = options.signal ? null : new AbortController();
    const timer = controller ? setTimeout(() => controller.abort(), 10000) : null;
    try {
        return await fetch(
            path,
            authHeaders({ ...options, signal: options.signal || controller!.signal }, token)
        );
    } finally {
        if (timer !== null) clearTimeout(timer);
    }
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
    const originalSession = session;
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
            if (session !== originalSession) return false;
            if (!resp.ok) {
                // Server outages must not destroy an otherwise valid offline identity.
                if (resp.status === 401 || resp.status === 403) logout();
                return false;
            }
            const data = await resp.json();
            if (session !== originalSession) return false;
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
    const originalSession = session;
    let response = await request(path, options);
    if (session !== originalSession) return response;
    if (response.status !== 401 || !session?.refresh_token) return response;
    if (!(await refreshTokens())) return response;
    if (session?.user?.id !== originalSession?.user?.id) return response;
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
 * 模块模式：经 game.profile 取身份/统计（幂等、失败视为未登录）。
 */
export async function restoreSession(): Promise<ServerUser | null> {
    if (platform()) {
        const profile = await moduleProfile();
        return userFromProfile(profile);
    }
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
