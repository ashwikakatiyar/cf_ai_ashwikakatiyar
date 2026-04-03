// The structured schema we're trying to fill via conversation
export interface PostmortemSchema {
  // Required fields - session is incomplete until all are populated
  title: string | null;
  severity: "SEV1" | "SEV2" | "SEV3" | "SEV4" | null;
  startTime: string | null;       // ISO 8601
  endTime: string | null;         // ISO 8601
  affectedSystems: string[] | null;
  userImpact: string | null;      // describe impact on end users
  rootCause: string | null;
  triggerEvent: string | null;    // what first caused or exposed the issue

  // Optional but valuable fields
  timeline: TimelineEvent[];
  detectionMethod: string | null; // how was it discovered
  responders: string[] | null;
  mitigationSteps: string | null;
  actionItems: ActionItem[];
  lessonsLearned: string | null;
}

export interface TimelineEvent {
  time: string;    // HH:MM or ISO
  description: string;
}

export interface ActionItem {
  description: string;
  owner: string | null;
  dueDate: string | null;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  timestamp: number;
}

// What the LLM returns on each turn
export interface LLMTurnResponse {
  // The question or message to show the user next
  reply: string;
  // Partial schema update inferred from the user's last message
  schemaPatch: Partial<PostmortemSchema>;
  // Whether all required fields are now filled
  complete: boolean;
}

export interface SessionState {
  sessionId: string;
  schema: PostmortemSchema;
  messages: ChatMessage[];
  complete: boolean;
  postmortemUrl: string | null;   // set after Workflow completes
  createdAt: number;
  updatedAt: number;
}

// Cloudflare bindings type
export interface Env {
  AI: Ai;
  INCIDENT_SESSION: DurableObjectNamespace;
  POSTMORTEM_WORKFLOW: Workflow;
  POSTMORTEMS_KV: KVNamespace;
  POSTMORTEMS_R2: R2Bucket;
  ASSETS: Fetcher;
}

export const REQUIRED_FIELDS: (keyof PostmortemSchema)[] = [
  "title",
  "severity",
  "startTime",
  "endTime",
  "affectedSystems",
  "userImpact",
  "rootCause",
  "triggerEvent",
];

export function getMissingFields(schema: PostmortemSchema): (keyof PostmortemSchema)[] {
  return REQUIRED_FIELDS.filter((field) => {
    const val = schema[field];
    if (val === null || val === undefined) return true;
    if (Array.isArray(val) && val.length === 0) return true;
    return false;
  });
}

export function emptySchema(): PostmortemSchema {
  return {
    title: null,
    severity: null,
    startTime: null,
    endTime: null,
    affectedSystems: null,
    userImpact: null,
    rootCause: null,
    triggerEvent: null,
    timeline: [],
    detectionMethod: null,
    responders: null,
    mitigationSteps: null,
    actionItems: [],
    lessonsLearned: null,
  };
}
