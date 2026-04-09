const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const snooze = require("./snooze");
const auth = require("./auth");

const CONFIG_PATH = process.env.CONFIG_PATH || path.join(__dirname, "config.json");

// ─── Session store (in-memory) ────────────────────────────────────────────────
const SESSION_TTL = 24 * 60 * 60 * 1000; // 24 hours
const sessions = new Map(); // token → { user, expires }

function createSession(user) {
    const token = auth.generateToken("ws-");
    sessions.set(token, { user, expires: Date.now() + SESSION_TTL });
    return token;
}

function validateSession(token) {
    if (!token) return null;
    const session = sessions.get(token);
    if (!session) return null;
    if (Date.now() > session.expires) { sessions.delete(token); return null; }
    return session;
}

function destroySession(token) {
    sessions.delete(token);
}

// Clean up expired sessions periodically
setInterval(() => {
    const now = Date.now();
    for (const [token, session] of sessions) {
        if (now > session.expires) sessions.delete(token);
    }
}, 60 * 60 * 1000);

// ─── Auth middleware ──────────────────────────────────────────────────────────

/** Require a valid web session token (Bearer in Authorization header) */
function requireSession(req, res, next) {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : null;
    if (!validateSession(token)) return res.status(401).json({ error: "Unauthorized" });
    next();
}

/** Require a valid MCP token; attaches token info to req.mcpToken */
function requireMcpToken(req, res, next) {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : null;
    const info = auth.validateMcpToken(token);
    if (!info) {
        return res.status(401).json({
            error: "Invalid or missing MCP token",
            hint: "Provide token in Authorization: Bearer <token>",
        });
    }
    req.mcpToken = info;
    next();
}

let reloadConfigFn = null;

function setReloadConfigFn(fn) {
    reloadConfigFn = fn;
}

function readConfig() {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
}

function writeConfig(cfg) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

function deepMerge(target, source) {
    const result = { ...target };
    for (const key of Object.keys(source)) {
        if (
            source[key] &&
            typeof source[key] === "object" &&
            !Array.isArray(source[key]) &&
            target[key] &&
            typeof target[key] === "object"
        ) {
            result[key] = deepMerge(target[key], source[key]);
        } else {
            result[key] = source[key];
        }
    }
    return result;
}

// ─── MCP Server (lazy-loaded to handle ESM/CJS compat) ───────────────────────

let mcpReady = false;
let McpServer, StreamableHTTPServerTransport, z;

async function loadMcpDeps() {
    if (mcpReady) return true;
    try {
        const mcpModule = await import("@modelcontextprotocol/sdk/server/mcp.js");
        const httpModule = await import("@modelcontextprotocol/sdk/server/streamableHttp.js");
        const zodModule = await import("zod");
        McpServer = mcpModule.McpServer;
        StreamableHTTPServerTransport = httpModule.StreamableHTTPServerTransport;
        z = zodModule.z;
        mcpReady = true;
        return true;
    } catch (e) {
        console.error("❌ Failed to load MCP SDK:", e.message);
        return false;
    }
}

function createMcpServer(allowedTools = null) {
    const server = new McpServer({
        name: "frigate-alerts",
        version: "1.0.0",
        description: "Manage Frigate Alerts configuration and snooze settings",
    });

    // Only register a tool if the token's scope allows it
    const allow = (name) => !allowedTools || allowedTools.includes(name);

    // ── Status (available to all valid tokens) ────────────────────────────────

    if (allow("get_status")) server.tool(
        "get_status",
        "Get service status: uptime, camera/group counts, active snoozes, connection info",
        {},
        async () => {
            const cfg = readConfig();
            const cameras = cfg.cameras || {};
            const groups = cfg.groups || {};
            const status = {
                service: "running",
                uptime_seconds: Math.floor(process.uptime()),
                cameras: Object.keys(cameras),
                cameras_count: Object.keys(cameras).length,
                groups: Object.keys(groups),
                groups_count: Object.keys(groups).length,
                active_snoozes: snooze.getSnoozeState(),
                frigate_api: cfg.frigate_api_url,
                mqtt_host: cfg.mqtt?.host,
            };
            return { content: [{ type: "text", text: JSON.stringify(status, null, 2) }] };
        }
    );

    // ── Config tools (admin scope) ────────────────────────────────────────────

    if (allow("get_config")) server.tool(
        "get_config",
        "Get the current configuration (cameras, groups, schedules, MQTT, etc.)",
        {},
        async () => {
            const cfg = readConfig();
            return { content: [{ type: "text", text: JSON.stringify(cfg, null, 2) }] };
        }
    );

    if (allow("update_config")) server.tool(
        "update_config",
        "Deep-merge updates into the config. Useful for changing general settings like frigate_api_url, default_schedule, etc.",
        { updates: z.record(z.any()).describe("Config fields to update (deep merged)") },
        async ({ updates }) => {
            const cfg = readConfig();
            const merged = deepMerge(cfg, updates);
            writeConfig(merged);
            if (reloadConfigFn) reloadConfigFn();
            return { content: [{ type: "text", text: "Configuration updated and reloaded." }] };
        }
    );

    // ── Camera tools (admin scope) ────────────────────────────────────────────

    if (allow("get_cameras")) server.tool(
        "get_cameras",
        "List all camera configurations",
        {},
        async () => {
            const cfg = readConfig();
            return { content: [{ type: "text", text: JSON.stringify(cfg.cameras || {}, null, 2) }] };
        }
    );

    if (allow("add_camera")) server.tool(
        "add_camera",
        "Add or replace a camera configuration",
        {
            name: z.string().describe("Camera name (must match Frigate camera name exactly)"),
            groups: z.array(z.string()).optional().describe("Group names that receive alerts from this camera"),
            labels: z.array(z.string()).optional().describe('Label filter e.g. ["person","car"]. Omit for all labels.'),
            always_send: z.boolean().optional().describe("Override schedule and always send alerts"),
            schedule: z.object({ start_time: z.string().describe("HH:MM"), end_time: z.string().describe("HH:MM") }).optional(),
        },
        async ({ name, groups, labels, always_send, schedule }) => {
            const cfg = readConfig();
            if (!cfg.cameras) cfg.cameras = {};
            const cam = {};
            if (groups !== undefined) cam.groups = groups;
            if (labels !== undefined) cam.labels = labels;
            if (always_send !== undefined) cam.always_send = always_send;
            if (schedule !== undefined) cam.schedule = schedule;
            cfg.cameras[name] = cam;
            writeConfig(cfg);
            if (reloadConfigFn) reloadConfigFn();
            return { content: [{ type: "text", text: `Camera "${name}" saved.` }] };
        }
    );

    if (allow("update_camera")) server.tool(
        "update_camera",
        "Update specific fields of an existing camera",
        { name: z.string().describe("Camera name"), updates: z.record(z.any()).describe("Fields to update (deep merged)") },
        async ({ name, updates }) => {
            const cfg = readConfig();
            if (!cfg.cameras?.[name]) return { content: [{ type: "text", text: `Camera "${name}" not found.` }] };
            cfg.cameras[name] = deepMerge(cfg.cameras[name], updates);
            writeConfig(cfg);
            if (reloadConfigFn) reloadConfigFn();
            return { content: [{ type: "text", text: `Camera "${name}" updated.` }] };
        }
    );

    if (allow("remove_camera")) server.tool(
        "remove_camera",
        "Remove a camera configuration",
        { name: z.string().describe("Camera name") },
        async ({ name }) => {
            const cfg = readConfig();
            if (!cfg.cameras?.[name]) return { content: [{ type: "text", text: `Camera "${name}" not found.` }] };
            delete cfg.cameras[name];
            writeConfig(cfg);
            if (reloadConfigFn) reloadConfigFn();
            return { content: [{ type: "text", text: `Camera "${name}" removed.` }] };
        }
    );

    // ── Group tools (admin scope) ─────────────────────────────────────────────

    if (allow("get_groups")) server.tool(
        "get_groups",
        "List all group configurations",
        {},
        async () => {
            const cfg = readConfig();
            return { content: [{ type: "text", text: JSON.stringify(cfg.groups || {}, null, 2) }] };
        }
    );

    if (allow("add_group")) server.tool(
        "add_group",
        "Add or replace a Telegram group/chat configuration",
        {
            name: z.string().describe("Group name (identifier used in camera configs)"),
            chat_id: z.string().describe("Telegram chat ID (negative for group chats)"),
            enabled: z.boolean().optional().describe("Enable or disable this group"),
            always_send: z.boolean().optional().describe("Send regardless of schedule"),
            description: z.string().optional().describe("Human-readable description"),
            schedule: z.object({ start_time: z.string().describe("HH:MM"), end_time: z.string().describe("HH:MM") }).optional(),
        },
        async ({ name, chat_id, enabled, always_send, description, schedule }) => {
            const cfg = readConfig();
            if (!cfg.groups) cfg.groups = {};
            const grp = { chat_id };
            if (enabled !== undefined) grp.enabled = enabled;
            if (always_send !== undefined) grp.always_send = always_send;
            if (description !== undefined) grp.description = description;
            if (schedule !== undefined) grp.schedule = schedule;
            cfg.groups[name] = grp;
            writeConfig(cfg);
            if (reloadConfigFn) reloadConfigFn();
            return { content: [{ type: "text", text: `Group "${name}" saved.` }] };
        }
    );

    if (allow("update_group")) server.tool(
        "update_group",
        "Update specific fields of an existing group",
        { name: z.string().describe("Group name"), updates: z.record(z.any()).describe("Fields to update") },
        async ({ name, updates }) => {
            const cfg = readConfig();
            if (!cfg.groups?.[name]) return { content: [{ type: "text", text: `Group "${name}" not found.` }] };
            cfg.groups[name] = deepMerge(cfg.groups[name], updates);
            writeConfig(cfg);
            if (reloadConfigFn) reloadConfigFn();
            return { content: [{ type: "text", text: `Group "${name}" updated.` }] };
        }
    );

    if (allow("remove_group")) server.tool(
        "remove_group",
        "Remove a group configuration",
        { name: z.string().describe("Group name") },
        async ({ name }) => {
            const cfg = readConfig();
            if (!cfg.groups?.[name]) return { content: [{ type: "text", text: `Group "${name}" not found.` }] };
            delete cfg.groups[name];
            writeConfig(cfg);
            if (reloadConfigFn) reloadConfigFn();
            return { content: [{ type: "text", text: `Group "${name}" removed.` }] };
        }
    );

    // ── Snooze tools (snooze + admin scopes) ─────────────────────────────────

    if (allow("get_snooze_state")) server.tool(
        "get_snooze_state",
        "Get all currently active snooze settings with remaining time",
        {},
        async () => ({ content: [{ type: "text", text: JSON.stringify(snooze.getSnoozeState(), null, 2) }] })
    );

    if (allow("set_snooze")) server.tool(
        "set_snooze",
        'Snooze alerts for a target: "global", "camera:<name>", or "group:<name>". Provide duration_minutes or until_datetime.',
        {
            target: z.string().describe('e.g. "global", "camera:front_door", "group:family"'),
            duration_minutes: z.number().optional().describe("Snooze for this many minutes from now"),
            until_datetime: z.string().optional().describe('Snooze until ISO 8601 datetime e.g. "2025-06-01T08:00:00"'),
        },
        async ({ target, duration_minutes, until_datetime }) => {
            if (duration_minutes !== undefined) {
                snooze.setSnoozeFor(target, duration_minutes);
                return { content: [{ type: "text", text: `Snoozed "${target}" for ${duration_minutes} minutes.` }] };
            } else if (until_datetime) {
                snooze.setSnoozeUntil(target, until_datetime);
                return { content: [{ type: "text", text: `Snoozed "${target}" until ${until_datetime}.` }] };
            }
            return { content: [{ type: "text", text: "Error: provide duration_minutes or until_datetime." }] };
        }
    );

    if (allow("clear_snooze")) server.tool(
        "clear_snooze",
        "Clear snooze for a specific target, or all snoozes if target is omitted",
        { target: z.string().optional().describe("Target to clear. Omit to clear all.") },
        async ({ target }) => {
            snooze.clearSnooze(target);
            return { content: [{ type: "text", text: target ? `Snooze cleared for "${target}".` : "All snoozes cleared." }] };
        }
    );

    // ── Restart (admin scope) ─────────────────────────────────────────────────

    if (allow("restart_service")) server.tool(
        "restart_service",
        "Restart the Frigate Alerts service (relies on systemd or nodemon to bring it back up)",
        {},
        async () => {
            setTimeout(() => process.exit(0), 500);
            return { content: [{ type: "text", text: "Restarting service..." }] };
        }
    );

    return server;
}

// ─── Express App ──────────────────────────────────────────────────────────────

const app = express();
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, "public")));

// ── OAuth 2.0 endpoints (required by MCP HTTP transport spec) ────────────────
// MCP clients do OAuth discovery before using Bearer tokens.
// These endpoints implement the minimal flow: register → token exchange.
// The MCP token from --header "Authorization: Bearer <token>" is validated
// at the token endpoint and returned as the access_token.

app.get("/.well-known/oauth-authorization-server", (req, res) => {
    const base = `${req.protocol}://${req.get("host")}`;
    res.json({
        issuer: base,
        token_endpoint: `${base}/oauth/token`,
        registration_endpoint: `${base}/oauth/register`,
        grant_types_supported: ["client_credentials"],
        token_endpoint_auth_methods_supported: ["none"],
        scopes_supported: ["snooze", "admin"],
        response_types_supported: ["token"],
    });
});

app.get("/.well-known/oauth-protected-resource", (req, res) => {
    const base = `${req.protocol}://${req.get("host")}`;
    res.json({
        resource: base,
        authorization_servers: [base],
    });
});

// Dynamic client registration — no credentials needed, just issue a client_id
app.post("/oauth/register", (req, res) => {
    res.status(201).json({
        client_id: crypto.randomUUID(),
        client_id_issued_at: Math.floor(Date.now() / 1000),
        token_endpoint_auth_method: "none",
        grant_types: ["client_credentials"],
    });
});

// Also handle without /oauth/ prefix (some clients use default paths)
app.post("/register", (req, res) => {
    res.status(201).json({
        client_id: crypto.randomUUID(),
        client_id_issued_at: Math.floor(Date.now() / 1000),
        token_endpoint_auth_method: "none",
        grant_types: ["client_credentials"],
    });
});

// Token endpoint — MCP token provided via Authorization: Bearer header is
// validated and returned as the access_token. Claude Code sends --header
// values to all requests including this one.
function handleTokenRequest(req, res) {
    const authHeader = req.headers.authorization || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!token) {
        return res.status(401).json({
            error: "invalid_client",
            error_description: "Provide your MCP token as: Authorization: Bearer <token>",
        });
    }
    const tokenInfo = auth.validateMcpToken(token);
    if (!tokenInfo) {
        return res.status(401).json({
            error: "invalid_client",
            error_description: "Invalid MCP token",
        });
    }
    res.json({
        access_token: token,
        token_type: "bearer",
        expires_in: 86400,
        scope: tokenInfo.scope,
    });
}

app.post("/oauth/token", handleTokenRequest);
app.post("/token", handleTokenRequest);

// ── Auth endpoints (no session required) ─────────────────────────────────────

app.post("/auth/login", (req, res) => {
    const { username, password } = req.body || {};
    if (!username || !password)
        return res.status(400).json({ error: "username and password required" });
    if (!auth.validateWebCredentials(username, password))
        return res.status(401).json({ error: "Invalid credentials" });
    const token = createSession(username);
    res.json({ token, user: username });
});

app.post("/auth/logout", (req, res) => {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : null;
    if (token) destroySession(token);
    res.json({ success: true });
});

app.get("/auth/me", (req, res) => {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : null;
    const session = validateSession(token);
    if (!session) return res.status(401).json({ error: "Unauthorized" });
    res.json({ user: session.user });
});

// ── Auth management (session required) ───────────────────────────────────────

app.post("/api/auth/password", requireSession, (req, res) => {
    const { username, password } = req.body || {};
    if (!username || !password)
        return res.status(400).json({ error: "username and password required" });
    auth.changeCredentials(username, password);
    res.json({ success: true });
});

// MCP token management
app.get("/api/auth/mcp-tokens", requireSession, (req, res) => {
    res.json(auth.listMcpTokens());
});

app.post("/api/auth/mcp-tokens", requireSession, (req, res) => {
    const { name, scope } = req.body || {};
    if (!name) return res.status(400).json({ error: "name is required" });
    if (!["snooze", "admin"].includes(scope))
        return res.status(400).json({ error: "scope must be 'snooze' or 'admin'" });
    try {
        const result = auth.addMcpToken(name, scope);
        res.json(result); // returns { id, token } — full token shown once
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

app.get("/api/auth/mcp-tokens/:id/value", requireSession, (req, res) => {
    const token = auth.getMcpTokenValue(req.params.id);
    if (!token) return res.status(404).json({ error: "Token not found" });
    res.json({ token });
});

app.delete("/api/auth/mcp-tokens/:id", requireSession, (req, res) => {
    const removed = auth.removeMcpToken(req.params.id);
    if (!removed) return res.status(404).json({ error: "Token not found" });
    res.json({ success: true });
});

// ── MCP HTTP endpoint ─────────────────────────────────────────────────────────

app.post("/mcp", requireMcpToken, async (req, res) => {
    const loaded = await loadMcpDeps();
    if (!loaded) {
        return res.status(503).json({ error: "MCP SDK not available. Run npm install." });
    }
    try {
        const server = createMcpServer(req.mcpToken.allowedTools);
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        res.on("close", () => {
            transport.close();
            server.close();
        });
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
    } catch (err) {
        console.error("MCP error:", err);
        if (!res.headersSent) res.status(500).json({ error: err.message });
    }
});

app.get("/mcp", (req, res) => {
    res.status(405).json({ error: "Use POST for MCP requests", endpoint: "POST /mcp" });
});

app.get("/mcp/info", requireMcpToken, (req, res) => {
    res.json({
        name: "frigate-alerts",
        version: "1.0.0",
        description: "MCP server for Frigate Alerts — manage config and snooze via AI tools",
        mcp_endpoint: "POST /mcp",
        tools: [
            "get_config", "update_config", "get_status",
            "get_cameras", "add_camera", "update_camera", "remove_camera",
            "get_groups", "add_group", "update_group", "remove_group",
            "get_snooze_state", "set_snooze", "clear_snooze",
        ],
    });
});

// ── REST API (all routes below require a valid web session) ───────────────────
app.use("/api", requireSession);

// Status
app.get("/api/status", (req, res) => {
    try {
        const cfg = readConfig();
        const cameras = cfg.cameras || {};
        const groups = cfg.groups || {};
        res.json({
            service: "running",
            uptime_seconds: Math.floor(process.uptime()),
            cameras: Object.keys(cameras),
            cameras_count: Object.keys(cameras).length,
            groups: Object.keys(groups),
            groups_count: Object.keys(groups).length,
            active_snoozes: snooze.getSnoozeState(),
            frigate_api: cfg.frigate_api_url,
            mqtt_host: cfg.mqtt?.host,
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Config
app.get("/api/config", (req, res) => {
    try {
        res.json(readConfig());
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.put("/api/config", (req, res) => {
    try {
        writeConfig(req.body);
        if (reloadConfigFn) reloadConfigFn();
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.patch("/api/config", (req, res) => {
    try {
        const cfg = readConfig();
        writeConfig(deepMerge(cfg, req.body));
        if (reloadConfigFn) reloadConfigFn();
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Cameras
app.get("/api/cameras", (req, res) => {
    try {
        res.json(readConfig().cameras || {});
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post("/api/cameras", (req, res) => {
    try {
        const { name, ...cameraConfig } = req.body;
        if (!name) return res.status(400).json({ error: "name is required" });
        const cfg = readConfig();
        if (!cfg.cameras) cfg.cameras = {};
        cfg.cameras[name] = cameraConfig;
        writeConfig(cfg);
        if (reloadConfigFn) reloadConfigFn();
        res.json({ success: true, name });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.put("/api/cameras/:name", (req, res) => {
    try {
        const cfg = readConfig();
        if (!cfg.cameras) cfg.cameras = {};
        cfg.cameras[req.params.name] = req.body;
        writeConfig(cfg);
        if (reloadConfigFn) reloadConfigFn();
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.delete("/api/cameras/:name", (req, res) => {
    try {
        const cfg = readConfig();
        if (!cfg.cameras?.[req.params.name])
            return res.status(404).json({ error: "Camera not found" });
        delete cfg.cameras[req.params.name];
        writeConfig(cfg);
        if (reloadConfigFn) reloadConfigFn();
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Groups
app.get("/api/groups", (req, res) => {
    try {
        res.json(readConfig().groups || {});
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post("/api/groups", (req, res) => {
    try {
        const { name, ...groupConfig } = req.body;
        if (!name) return res.status(400).json({ error: "name is required" });
        const cfg = readConfig();
        if (!cfg.groups) cfg.groups = {};
        cfg.groups[name] = groupConfig;
        writeConfig(cfg);
        if (reloadConfigFn) reloadConfigFn();
        res.json({ success: true, name });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.put("/api/groups/:name", (req, res) => {
    try {
        const cfg = readConfig();
        if (!cfg.groups) cfg.groups = {};
        cfg.groups[req.params.name] = req.body;
        writeConfig(cfg);
        if (reloadConfigFn) reloadConfigFn();
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.delete("/api/groups/:name", (req, res) => {
    try {
        const cfg = readConfig();
        if (!cfg.groups?.[req.params.name])
            return res.status(404).json({ error: "Group not found" });
        delete cfg.groups[req.params.name];
        writeConfig(cfg);
        if (reloadConfigFn) reloadConfigFn();
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Snooze
app.get("/api/snooze", (req, res) => {
    res.json(snooze.getSnoozeState());
});

app.post("/api/snooze", (req, res) => {
    try {
        const { target, duration_minutes, until_datetime } = req.body;
        if (!target) return res.status(400).json({ error: "target is required" });
        if (duration_minutes !== undefined) {
            snooze.setSnoozeFor(target, Number(duration_minutes));
        } else if (until_datetime) {
            snooze.setSnoozeUntil(target, until_datetime);
        } else {
            return res.status(400).json({ error: "duration_minutes or until_datetime required" });
        }
        res.json({ success: true, state: snooze.getSnoozeState() });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

app.delete("/api/snooze", (req, res) => {
    snooze.clearSnooze();
    res.json({ success: true });
});

// Handles targets like "camera:front_door" or "group:family"
app.delete("/api/snooze/:target(*)", (req, res) => {
    snooze.clearSnooze(decodeURIComponent(req.params.target));
    res.json({ success: true });
});

// ── Start server ──────────────────────────────────────────────────────────────

function startServer(port) {
    auth.ensureAuth();
    const p = port || process.env.GUI_PORT || 8099;
    app.listen(p, () => {
        console.log(`🌐 Web GUI:      http://localhost:${p}`);
        console.log(`🔌 MCP endpoint: http://localhost:${p}/mcp`);
        console.log(`📡 REST API:     http://localhost:${p}/api`);
    });
    // Pre-load MCP deps in background
    loadMcpDeps().then((ok) => {
        if (ok) console.log("✅ MCP SDK loaded");
    });
    return app;
}

module.exports = { startServer, setReloadConfigFn };
