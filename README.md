# cf_ai_postmortem

An AI-powered incident postmortem generator built on Cloudflare's AI stack.

Describe your incident in plain English. The assistant interviews you with targeted follow-up questions, extracts structured data in real time, then generates a polished postmortem report.

## Architecture

| Component | Cloudflare primitive | Purpose |
|-----------|---------------------|---------|
| LLM | Workers AI (Llama 3.3 70B) | Drives Q&A interview, extracts schema fields, generates final doc |
| State / memory | Durable Objects | Conversation history + partially-filled schema per session; WebSocket hub |
| Coordination | Cloudflare Workflows | Triggered on completion — generates, stores, notifies client |
| Storage | KV + R2 | KV for index/metadata, R2 for Markdown download |
| Frontend | Static HTML | Real-time chat UI with live field progress sidebar |

## Deployed URL
[https://cf-ai-postmortem.ashwikakatiyar.workers.dev](https://cf-ai-postmortem.ashwikakatiyar.workers.dev)

## How it works

The LLM receives the postmortem schema as structured JSON in its system prompt and returns a JSON object on every turn containing a natural language reply and a schema patch. The Durable Object applies the patch and triggers the Workflow once all 8 required fields are filled.
