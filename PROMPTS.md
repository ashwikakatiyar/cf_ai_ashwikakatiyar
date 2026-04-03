# PROMPTS.md

This file documents all AI prompts used in building this project, as required by the assignment.

---

## 1. Interview system prompt (src/prompts.ts - buildSystemPrompt)

Used on every chat turn. The schema is injected dynamically so the LLM always knows what has been collected and what is still missing.

**Purpose:** Drive a structured interview, extract fields from user answers, return a JSON patch.

**Key design decisions:**
- Instructing the LLM to return ONLY JSON (no prose wrapper) makes parsing deterministic
- Injecting the current schema state means the LLM never asks for info already collected
- Asking for ONE question per turn keeps the conversation natural vs. a form dump
- Low temperature (0.3) reduces hallucination on field extraction

**Prompt:**
See `src/prompts.ts` > `buildSystemPrompt()` — the full prompt is constructed at runtime with the current schema injected.

Core instruction excerpt:
> "You MUST always respond with ONLY a valid JSON object... { reply, schemaPatch, complete }"
> "Infer as much as possible from what the user says — if they say 'it went down at 2pm and came back at 4', extract both startTime and endTime."

---

## 2. Generation prompt (src/prompts.ts - buildGenerationPrompt)

Used once at the end, inside the Cloudflare Workflow, to generate the final Markdown document.

**Purpose:** Transform the completed structured schema into a polished postmortem document.

**Key design decisions:**
- Low temperature (0.2) for consistent, professional formatting
- Exact Markdown template specified so output is predictable and renderable
- Instructs the model to generate reasonable lessons learned if the user didn't provide them

**Prompt:**
See `src/prompts.ts` > `buildGenerationPrompt()`.

Core instruction:
> "Output only the Markdown, no preamble."

---

## 3. AI-assisted coding prompts (Claude claude-sonnet-4-20250514)

The following prompts were used with Claude to help scaffold this project:

**Architecture planning:**
> "I'm building an AI-powered incident postmortem generator for a Cloudflare internship assignment. The app must use: LLM (Llama 3.3 on Workers AI), Workflow/Durable Objects, user input via chat, memory/state. Can you design the full architecture and component breakdown?"

**Code scaffolding:**
> "Yes please scaffold the actual code — starting with the Durable Object and system prompt."

**Specific implementation questions asked during development:**
- How to handle WebSocket reconnection with Durable Objects
- How to structure the JSON schema patch pattern for LLM-driven form filling
- Best practices for Cloudflare Workflows error handling and retries
