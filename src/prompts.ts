import type { PostmortemSchema } from "./types/index.js";
import { getMissingFields } from "./types/index.js";

/** Returns true if the LLM reply looks like a report or long analysis rather than a short chat message. */
export function isReportLike(reply: string): boolean {
  const hasHeaders = /^#{1,3} /m.test(reply);
  const hasHR = /^---/m.test(reply);
  const hasSectionWords = /\*\*(Summary|Impact|Root Cause|Timeline|Resolution|Action Items|Incident Report)[\*:]/.test(reply);
  // Numbered lists (e.g. "1. something\n2. something")
  const hasNumberedList = /^\d+\.\s/m.test(reply) && /^\d+\.\s/gm.test(reply) && (reply.match(/^\d+\.\s/gm) ?? []).length >= 2;
  const isTooLong = reply.length > 400;
  return hasHeaders || hasHR || hasSectionWords || hasNumberedList || isTooLong;
}

/** Returns true if the reply was cut off (doesn't end with sentence-ending punctuation). */
export function isTruncated(reply: string): boolean {
  return !/[.!?]$/.test(reply.trimEnd());
}

const QUESTIONS: Partial<Record<keyof PostmortemSchema, string>> = {
  severity: "How severe was this? SEV1 means all users were affected, SEV4 is minor — which fits best?",
  startTime: "What time did the incident start?",
  endTime: "And when was it fully resolved?",
  affectedSystems: "Which systems or services were affected?",
  triggerEvent: "What specifically triggered the incident — the event that set it off?",
  rootCause: "What was the underlying root cause?",
  userImpact: "How did this impact users — what were they unable to do?",
};

/** Returns the next interview question for the first missing required field. */
export function getNextQuestion(schema: PostmortemSchema): string {
  const missing = getMissingFields(schema);
  if (missing.length === 0) return "I have everything I need! Would you like to generate your report now?";
  const next = missing[0] as keyof PostmortemSchema;
  return QUESTIONS[next] ?? `Can you tell me more about ${String(next)}?`;
}

export function buildSystemPrompt(schema: PostmortemSchema): string {
  const missing = getMissingFields(schema);

  return `You are an expert SRE helping an engineer fill out a production incident postmortem through a friendly chat interview.

## CRITICAL rules — follow these exactly

1. Ask ONLY ONE question per reply. Never ask two questions in the same message.
2. NEVER generate a postmortem document, incident report, summary, or any multi-section formatted output during this conversation. When all fields are collected, the report will appear automatically in this chat — you do not need to mention it or direct the user anywhere. Your only job right now is to gather information through questions.
3. Keep replies short — 1-3 sentences max. Be warm and conversational, not formal.
4. Do not repeat back everything the user told you. Just acknowledge briefly and ask the next question.
5. Do not use bullet lists or headers in your replies. Plain conversational prose only.

## Current status
${missing.length === 0
  ? "ALL REQUIRED FIELDS ARE COMPLETE. Say ONLY: \"Perfect, I have everything I need! Your postmortem is being generated and will appear here in a moment.\" Do NOT mention a download link, sidebar, or any other location."
  : `Still need: ${missing.join(", ")}`}

IMPORTANT: Never mention a download link. When all fields are collected, just say you have everything you need — the report will appear directly in this chat.

## Interview order (ask about missing fields in this order)
severity → startTime → endTime → affectedSystems → triggerEvent → rootCause → userImpact → action items

## Example of a good reply
User: "The database went down for about an hour"
You: "Got it. How would you rate the severity — SEV1 (critical, all users affected) through SEV4 (minor)?"

## Example of a BAD reply (never do this)
You: "**Incident Report: Database Outage** **Summary:** On [Date]..." ← DO NOT DO THIS
`;
}

export function buildExtractionPrompt(allUserText: string, schema: PostmortemSchema): string {
  return `Extract incident fields from the following engineer messages. Return ONLY a JSON object (no markdown, no explanation) with only the fields that are present or clearly inferable. Omit fields with no information.

Engineer messages:
"""
${allUserText}
"""

Current known values (do not re-extract fields already filled unless you have better data):
${JSON.stringify(schema, null, 2)}

Field rules:
- title: short descriptive string
- severity: one of "SEV1", "SEV2", "SEV3", "SEV4" only
- startTime: ISO 8601 string. Infer from: explicit start time, first timeline entry, when the outage/incident began. If a date is given (e.g. "2015-10-21") combine it with the time. If only a time like "14:54" is given with no date, use ${new Date().toISOString().slice(0, 10)}.
- endTime: ISO 8601 string. Infer from: explicit end time, last timeline entry, when service was restored/incident ended.
- affectedSystems: array of strings
- userImpact: string describing what users experienced
- rootCause: string with the underlying technical cause
- triggerEvent: string with the specific event that caused it
- timeline: array of {time, description} — time as "HH:MM" or ISO
- actionItems: array of {description, owner, dueDate}

Return only a JSON object. Example: {"title": "...", "severity": "SEV2", "startTime": "2015-10-21T14:54:00Z"}`;
}

export function buildGenerationPrompt(schema: PostmortemSchema): string {
  return `You are an expert SRE writing a formal incident postmortem document.

Generate a complete, professional postmortem in Markdown based on this data:

\`\`\`json
${JSON.stringify(schema, null, 2)}
\`\`\`

Format the document exactly as follows:

# Incident Postmortem: {title}

**Severity:** {severity}  
**Date:** {date from startTime}  
**Duration:** {calculated from startTime and endTime}  
**Status:** Resolved

---

## Summary
2-3 sentence executive summary of what happened and its impact.

## Impact
- **User impact:** {userImpact}
- **Affected systems:** {comma-separated affectedSystems}
- **Duration:** {human-readable duration}

## Timeline
| Time | Event |
|------|-------|
{timeline table rows, chronological}

## Root Cause
{rootCause - write 2-3 clear sentences explaining the technical cause}

## Trigger
{triggerEvent - one sentence on what specifically set this off}

## Detection
{detectionMethod or "Detected via internal monitoring" if null}

## Resolution
{mitigationSteps in a numbered list, or "See action items" if null}

## Action Items
| Action | Owner | Due Date |
|--------|-------|----------|
{actionItems table rows, or a placeholder row if empty}

## Lessons Learned
{lessonsLearned, or generate 2-3 insightful lessons from the incident data if null}

---
*Postmortem generated by cf_ai_postmortem on ${new Date().toISOString()}*

Write the full document now. Output only the Markdown, no preamble.
`;
}

