import type { Env } from "./types/index.js";
export { IncidentSession } from "./durableObject.js";
export { PostmortemWorkflow } from "./workflow.js";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // CORS headers for Pages frontend
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Upgrade, Connection",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    // --- WebSocket: /api/session/:sessionId/ws ---
    // Upgrades to WebSocket and routes to a specific Durable Object instance
    const wsMatch = url.pathname.match(/^\/api\/session\/([^/]+)\/ws$/);
    if (wsMatch) {
      const sessionId = wsMatch[1];
      const id = env.INCIDENT_SESSION.idFromName(sessionId);
      const stub = env.INCIDENT_SESSION.get(id);
      return stub.fetch(request);
    }

    // --- Create new session: POST /api/session ---
    if (url.pathname === "/api/session" && request.method === "POST") {
      const sessionId = crypto.randomUUID();
      return new Response(
        JSON.stringify({ sessionId, wsUrl: `/api/session/${sessionId}/ws` }),
        {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    // --- Get session state: GET /api/session/:sessionId ---
    const sessionMatch = url.pathname.match(/^\/api\/session\/([^/]+)$/);
    if (sessionMatch && request.method === "GET") {
      const sessionId = sessionMatch[1];
      const id = env.INCIDENT_SESSION.idFromName(sessionId);
      const stub = env.INCIDENT_SESSION.get(id);
      const response = await stub.fetch(
        new Request(`https://internal/session`, { method: "GET" })
      );
      return new Response(response.body, {
        status: response.status,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // --- Download postmortem: GET /api/download/:sessionId ---
    const downloadMatch = url.pathname.match(/^\/api\/download\/([^/]+)$/);
    if (downloadMatch && request.method === "GET") {
      const sessionId = downloadMatch[1];
      const object = await env.POSTMORTEMS_R2.get(
        `postmortems/${sessionId}.md`
      );

      if (!object) {
        return new Response(JSON.stringify({ error: "Postmortem not found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      }

      return new Response(object.body, {
        headers: {
          "Content-Type": "text/markdown",
          "Content-Disposition": `attachment; filename="postmortem-${sessionId}.md"`,
          ...corsHeaders,
        },
      });
    }

    // --- List postmortems: GET /api/postmortems ---
    if (url.pathname === "/api/postmortems" && request.method === "GET") {
      const list = await env.POSTMORTEMS_KV.list({ prefix: "postmortem:" });
      const postmortems = await Promise.all(
        list.keys.map(async (key) => {
          const raw = await env.POSTMORTEMS_KV.get(key.name);
          if (!raw) return null;
          const record = JSON.parse(raw);
          return {
            sessionId: record.sessionId,
            title: record.schema?.title,
            severity: record.schema?.severity,
            generatedAt: record.generatedAt,
            downloadUrl: record.downloadUrl,
          };
        })
      );

      return new Response(
        JSON.stringify(postmortems.filter(Boolean)),
        {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    return env.ASSETS.fetch(request);
  },
};
