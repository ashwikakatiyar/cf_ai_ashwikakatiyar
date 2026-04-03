import type {
  Env,
  SessionState,
  ChatMessage,
  LLMTurnResponse,
  PostmortemSchema,
} from "./types/index.js";
import { emptySchema, getMissingFields } from "./types/index.js";
import { buildSystemPrompt, buildExtractionPrompt, buildGenerationPrompt, isReportLike, isTruncated, getNextQuestion } from "./prompts.js";

export class IncidentSession implements DurableObject {
  private state: DurableObjectState;
  private env: Env;
  private sessions: Set<WebSocket> = new Set();

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // WebSocket upgrade for real-time chat
    if (request.headers.get("Upgrade") === "websocket") {
      return this.handleWebSocket(request);
    }

    // REST endpoints for non-WS clients
    if (url.pathname.endsWith("/session") && request.method === "GET") {
      return this.handleGetSession();
    }

    return new Response("Not found", { status: 404 });
  }

  private async handleWebSocket(request: Request): Promise<Response> {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.state.acceptWebSocket(server);
    this.sessions.add(server);

    // Initialize session if first visit
    const existing = await this.state.storage.get<SessionState>("session");
    if (!existing) {
      await this.initSession();
      // Send the opening question
      await this.sendOpeningMessage(server);
    } else {
      // Reconnect: replay state to client
      server.send(JSON.stringify({ type: "state", session: existing }));
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    try {
      const data = JSON.parse(message as string);

      if (data.type === "message") {
        await this.processUserMessage(ws, data.content as string);
      }
    } catch (e) {
      ws.send(JSON.stringify({ type: "error", message: "Invalid message format" }));
    }
  }

  async webSocketClose(ws: WebSocket) {
    this.sessions.delete(ws);
  }

  private async initSession() {
    const sessionId = crypto.randomUUID();
    const session: SessionState = {
      sessionId,
      schema: emptySchema(),
      messages: [],
      complete: false,
      postmortemUrl: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await this.state.storage.put("session", session);
    return session;
  }

  private async sendOpeningMessage(ws: WebSocket) {
    const opening = "Hi! I'm here to help you write this postmortem while the details are fresh. To start — can you give me a brief description of what happened?";

    const session = await this.state.storage.get<SessionState>("session")!;
    const assistantMsg: ChatMessage = {
      role: "assistant",
      content: opening,
      timestamp: Date.now(),
    };

    session!.messages.push(assistantMsg);
    await this.state.storage.put("session", session);

    ws.send(JSON.stringify({ type: "message", message: assistantMsg }));
  }

  private async processUserMessage(ws: WebSocket, content: string) {
    const session = await this.state.storage.get<SessionState>("session");
    if (!session) {
      ws.send(JSON.stringify({ type: "error", message: "Session not found" }));
      return;
    }

    if (session.complete) {
      ws.send(JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          content: "Your postmortem has already been generated! Scroll up to see the full report.",
          timestamp: Date.now(),
        }
      }));
      return;
    }

    // Add user message to history
    const userMsg: ChatMessage = {
      role: "user",
      content,
      timestamp: Date.now(),
    };
    session.messages.push(userMsg);

    // Send typing indicator
    ws.send(JSON.stringify({ type: "typing" }));

    try {
      // Call Workers AI with full conversation history + structured system prompt
      const llmResponse = await this.callLLM(session);

      // Apply schema patch
      if (llmResponse.schemaPatch) {
        session.schema = { ...session.schema, ...llmResponse.schemaPatch };
      }

      const assistantMsg: ChatMessage = {
        role: "assistant",
        content: llmResponse.reply,
        timestamp: Date.now(),
      };
      session.messages.push(assistantMsg);
      session.updatedAt = Date.now();

      // Check completion
      const missing = getMissingFields(session.schema);
      if (missing.length === 0) {
        session.complete = true;
      }

      await this.state.storage.put("session", session);

      // Send reply to client
      ws.send(JSON.stringify({
        type: "message",
        message: assistantMsg,
        schema: session.schema,
        missingFields: missing,
        complete: session.complete,
      }));

      // If session just completed, generate the report inline and send it as a message
      if (session.complete) {
        // Show a typing indicator while generating the full report
        ws.send(JSON.stringify({ type: "typing" }));

        const markdown = await this.generateReport(session);

        const reportMsg = {
          role: "assistant" as const,
          content: markdown,
          timestamp: Date.now(),
          isReport: true,
        };

        session.messages.push(reportMsg);
        session.updatedAt = Date.now();
        await this.state.storage.put("session", session);

        ws.send(JSON.stringify({
          type: "message",
          message: reportMsg,
          isReport: true,
        }));

        // Also trigger the workflow for R2/KV storage (best-effort, fire-and-forget)
        this.triggerWorkflow(session).catch((e) =>
          console.error("Workflow trigger failed (non-fatal):", e)
        );
      }

    } catch (e) {
      console.error("LLM error:", e);
      ws.send(JSON.stringify({
        type: "error",
        message: "Something went wrong processing your message. Please try again.",
      }));
    }
  }

  private async callLLM(session: SessionState): Promise<LLMTurnResponse> {
    const userMessage = session.messages[session.messages.length - 1].content;

    const chatMessages = session.messages.map((m) => ({
      role: m.role,
      content: m.content,
    }));

    const [chatResponse, extractResponse] = await Promise.all([
      // Natural language reply to continue the interview
      (this.env.AI.run as Function)("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
        system: buildSystemPrompt(session.schema),
        messages: chatMessages,
        max_tokens: 256,
        temperature: 0.4,
      }),
      // Focused extraction: only job is to return JSON fields
      (this.env.AI.run as Function)("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
        messages: [
          {
            role: "user",
            content: buildExtractionPrompt(userMessage, session.schema),
          },
        ],
        max_tokens: 512,
        temperature: 0.1,
      }),
    ]);

    const rawReply = (chatResponse as { response: string }).response.trim();
    const reply = (isReportLike(rawReply) || isTruncated(rawReply))
      ? getNextQuestion(session.schema)
      : rawReply;

    // Parse the extraction response
    const extractBody = (extractResponse as any)?.response;
    let schemaPatch: Partial<PostmortemSchema> = {};
    if (extractBody && typeof extractBody === "object") {
      schemaPatch = extractBody;
    } else if (typeof extractBody === "string") {
      const firstBrace = extractBody.indexOf("{");
      const lastBrace = extractBody.lastIndexOf("}");
      if (firstBrace !== -1 && lastBrace !== -1) {
        try {
          schemaPatch = JSON.parse(extractBody.slice(firstBrace, lastBrace + 1));
        } catch {
          // extraction failed - proceed with empty patch
        }
      }
    }

    return { reply, schemaPatch, complete: false };
  }

  private async generateReport(session: SessionState): Promise<string> {
    const prompt = buildGenerationPrompt(session.schema);

    const response = await (this.env.AI.run as Function)(
      "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
      {
        system: "You are an expert SRE. Output only the requested Markdown document, no preamble or explanation.",
        messages: [{ role: "user", content: prompt }],
        max_tokens: 2048,
        temperature: 0.2,
      }
    );

    return (response as { response: string }).response.trim();
  }

  private async triggerWorkflow(session: SessionState) {
    await this.env.POSTMORTEM_WORKFLOW.create({
      id: session.sessionId,
      params: { session },
    });
  }

  private async handleGetSession(): Promise<Response> {
    const session = await this.state.storage.get<SessionState>("session");
    if (!session) {
      return new Response(JSON.stringify({ error: "Not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify(session), {
      headers: { "Content-Type": "application/json" },
    });
  }
}