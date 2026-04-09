const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const AUTH_FILE = path.join(__dirname, "auth.json");
const SALT = "frigate-alerts-v1";

// Available permission scopes
const SCOPES = {
    snooze: "snooze",   // snooze management only
    admin: "admin",     // config changes + snooze + restart
};

// Which MCP tools each scope grants access to
const SCOPE_TOOLS = {
    snooze: ["get_status", "get_snooze_state", "set_snooze", "clear_snooze"],
    admin: [
        "get_status",
        "get_snooze_state", "set_snooze", "clear_snooze",
        "get_config", "update_config",
        "get_cameras", "add_camera", "update_camera", "remove_camera",
        "get_groups", "add_group", "update_group", "remove_group",
        "restart_service",
    ],
};

function generateToken(prefix = "") {
    return prefix + crypto.randomBytes(28).toString("hex");
}

function hashPassword(password) {
    return crypto.createHash("sha256").update(SALT + password).digest("hex");
}

function loadAuth() {
    try {
        return JSON.parse(fs.readFileSync(AUTH_FILE, "utf8"));
    } catch (e) {
        return null;
    }
}

function saveAuth(auth) {
    fs.writeFileSync(AUTH_FILE, JSON.stringify(auth, null, 2));
}

/**
 * Migrate old single-token format to multi-token format.
 */
function migrateAuth(auth) {
    if (auth.mcp_token && !auth.mcp_tokens) {
        auth.mcp_tokens = [
            {
                id: crypto.randomUUID(),
                name: "Default (admin)",
                token: auth.mcp_token,
                scope: "admin",
                created: new Date().toISOString(),
            },
        ];
        delete auth.mcp_token;
        saveAuth(auth);
        console.log("🔑 Migrated MCP token to multi-token format");
    }
    return auth;
}

/**
 * Ensure auth.json exists with default credentials and tokens.
 */
function ensureAuth() {
    let auth = loadAuth();
    if (!auth) {
        const adminToken = generateToken("fa-");
        const snoozeToken = generateToken("fa-");
        auth = {
            web_username: "admin",
            web_password_hash: hashPassword("admin"),
            mcp_tokens: [
                {
                    id: crypto.randomUUID(),
                    name: "Admin",
                    token: adminToken,
                    scope: "admin",
                    created: new Date().toISOString(),
                },
                {
                    id: crypto.randomUUID(),
                    name: "Snooze Only",
                    token: snoozeToken,
                    scope: "snooze",
                    created: new Date().toISOString(),
                },
            ],
        };
        saveAuth(auth);
        console.log("🔑 Auth config created → auth.json");
        console.log("   Web login:    admin / admin  (change in Settings)");
        console.log(`   MCP admin:    ${adminToken}`);
        console.log(`   MCP snooze:   ${snoozeToken}`);
    } else {
        auth = migrateAuth(auth);
        const count = auth.mcp_tokens?.length || 0;
        console.log(`🔑 Auth loaded (${count} MCP token${count !== 1 ? "s" : ""})`);
    }
    return auth;
}

function validateWebCredentials(username, password) {
    const auth = loadAuth();
    if (!auth) return false;
    return auth.web_username === username && auth.web_password_hash === hashPassword(password);
}

/**
 * Validate an MCP Bearer token.
 * @param {string} token
 * @returns {{ id, name, scope, allowedTools: string[] } | null}
 */
function validateMcpToken(token) {
    if (!token) return null;
    const auth = loadAuth();
    const tokens = auth?.mcp_tokens || [];
    for (const entry of tokens) {
        try {
            const match = crypto.timingSafeEqual(
                Buffer.from(entry.token),
                Buffer.from(token)
            );
            if (match) {
                return {
                    id: entry.id,
                    name: entry.name,
                    scope: entry.scope,
                    allowedTools: SCOPE_TOOLS[entry.scope] || [],
                };
            }
        } catch {
            // length mismatch = not equal
        }
    }
    return null;
}

/**
 * List all MCP tokens (token value masked for safety).
 */
function listMcpTokens() {
    const auth = loadAuth();
    return (auth?.mcp_tokens || []).map((t) => ({
        id: t.id,
        name: t.name,
        scope: t.scope,
        created: t.created,
        token_preview: t.token.slice(0, 14) + "...",
    }));
}

/**
 * Get a single MCP token's full value (for display after creation).
 */
function getMcpTokenValue(id) {
    const auth = loadAuth();
    const entry = (auth?.mcp_tokens || []).find((t) => t.id === id);
    return entry?.token || null;
}

/**
 * Add a new MCP token.
 * @param {string} name
 * @param {"snooze"|"admin"} scope
 * @returns {{ id, token }}
 */
function addMcpToken(name, scope) {
    if (!SCOPE_TOOLS[scope]) throw new Error(`Invalid scope: ${scope}`);
    const auth = loadAuth() || {};
    if (!auth.mcp_tokens) auth.mcp_tokens = [];
    const id = crypto.randomUUID();
    const token = generateToken("fa-");
    auth.mcp_tokens.push({ id, name, token, scope, created: new Date().toISOString() });
    saveAuth(auth);
    console.log(`🔑 MCP token created: "${name}" (${scope})`);
    return { id, token };
}

/**
 * Remove an MCP token by id.
 */
function removeMcpToken(id) {
    const auth = loadAuth() || {};
    const before = (auth.mcp_tokens || []).length;
    auth.mcp_tokens = (auth.mcp_tokens || []).filter((t) => t.id !== id);
    if (auth.mcp_tokens.length === before) return false;
    saveAuth(auth);
    return true;
}

function changeCredentials(username, password) {
    const auth = loadAuth() || {};
    auth.web_username = username;
    auth.web_password_hash = hashPassword(password);
    saveAuth(auth);
}

module.exports = {
    SCOPES,
    SCOPE_TOOLS,
    ensureAuth,
    validateWebCredentials,
    validateMcpToken,
    listMcpTokens,
    getMcpTokenValue,
    addMcpToken,
    removeMcpToken,
    changeCredentials,
    generateToken,
};
