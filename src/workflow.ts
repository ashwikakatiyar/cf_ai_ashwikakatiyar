import type { Env, SessionState } from "./types/index.js";
import { buildGenerationPrompt } from "./prompts.js";

// WorkflowEvent and WorkflowStep are Cloudflare Workflows types
interface WorkflowEvent<T> {
  payload: T;
  timestamp: Date;
}

interface WorkflowStep {
  do<T>(name: string, fn: () => Promise<T>): Promise<T>;
  sleep(name: string, duration: string): Promise<void>;
}

export class PostmortemWorkflow {
  private env: Env;

  constructor(env: Env) {
    this.env = env;
  }

  async run(
    event: WorkflowEvent<{ session: SessionState }>,
    step: WorkflowStep
  ): Promise<void> {
    const { session } = event.payload;

    // Step 1: Generate the postmortem markdown
    const markdown = await step.do("generate-postmortem-markdown", async () => {
      const prompt = buildGenerationPrompt(session.schema);

      const response = await this.env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
        system: "You are an expert SRE. Output only the requested Markdown document, no preamble or explanation.",
        messages: [{ role: "user", content: prompt }],
        max_tokens: 2048,
        temperature: 0.2,
      });

      return (response as { response: string }).response.trim();
    });

    // Step 2: Save markdown to R2 for download
    const r2Key = await step.do("save-to-r2", async () => {
      const key = `postmortems/${session.sessionId}.md`;
      await this.env.POSTMORTEMS_R2.put(key, markdown, {
        httpMetadata: {
          contentType: "text/markdown",
          contentDisposition: `attachment; filename="postmortem-${session.sessionId}.md"`,
        },
        customMetadata: {
          sessionId: session.sessionId,
          title: session.schema.title ?? "Untitled Incident",
          severity: session.schema.severity ?? "unknown",
          createdAt: new Date().toISOString(),
        },
      });
      return key;
    });

    // Step 3: Save structured data + download URL to KV for retrieval
    await step.do("save-to-kv", async () => {
      const record = {
        sessionId: session.sessionId,
        schema: session.schema,
        markdown,
        r2Key,
        downloadUrl: `/api/download/${session.sessionId}`,
        generatedAt: new Date().toISOString(),
      };

      // Index by sessionId
      await this.env.POSTMORTEMS_KV.put(
        `postmortem:${session.sessionId}`,
        JSON.stringify(record),
        { expirationTtl: 60 * 60 * 24 * 90 } // 90 days
      );

      // Also index by date for listing
      await this.env.POSTMORTEMS_KV.put(
        `index:${new Date().toISOString().slice(0, 10)}:${session.sessionId}`,
        session.sessionId,
        { expirationTtl: 60 * 60 * 24 * 90 }
      );
    });

    // Step 4: Update the Durable Object with the download URL
    // (The DO will broadcast this to any connected WebSocket clients)
    await step.do("notify-session", async () => {
      const id = this.env.INCIDENT_SESSION.idFromName(session.sessionId);
      const stub = this.env.INCIDENT_SESSION.get(id);

      await stub.fetch("https://internal/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          postmortemUrl: `/api/download/${session.sessionId}`,
          markdown,
        }),
      });
    });
  }
}
