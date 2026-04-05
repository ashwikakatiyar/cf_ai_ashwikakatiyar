# cf_ai_postmortem

An AI-powered incident postmortem generator built on Cloudflare's AI stack.

Describe your incident in plain English. The assistant interviews you with targeted follow-up questions, extracts structured data in real time, then generates a polished postmortem markdown document.

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

The Durable Object sends the full conversation history and the current schema to the LLM. It uses one LLM call for a natural language assistant reply and a second focused extraction call to infer a JSON schema patch from the latest user message. The Durable Object merges that patch into session state, marks the session complete when all required fields are present, generates the postmortem markdown inline, and fires a best-effort Workflow trigger for downstream storage and processing.
