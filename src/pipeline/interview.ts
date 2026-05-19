// Deep-interview phase. When a brief is too vague to plan against, the
// architect produces up to 3 clarifying questions instead of a plan, the
// pipeline posts them to the originating Discord thread (via the injected
// poster), and the sprint halts with status `awaiting_interview`. The reply
// path is owned downstream (Discord message-create handler / MCP) — this file
// only defines the contract the pipeline needs to halt cleanly.

const VAGUE_BODY_MIN_LEN = 200;
const VAGUE_MAX_QUESTION_MARKS = 2;
const ACCEPTANCE_HEADER = /^##\s+Acceptance\b/m;

export const INTERVIEW_SYSTEM_PROMPT = `You are the Architect, but the brief is too vague to plan against. Ask up to 3 short clarifying questions BEFORE any planning happens.

Output ONLY a <questions> block:
<questions>
1. ...
2. ...
3. ...
</questions>
Each question is one sentence. If 1 or 2 questions are enough, output fewer. Do not include any prose outside the block.`;

export function isVagueBrief(body: string): boolean {
  if (!body) return true;
  if (body.length < VAGUE_BODY_MIN_LEN) return true;
  if (!ACCEPTANCE_HEADER.test(body)) return true;
  const questionMarks = (body.match(/\?/g) ?? []).length;
  if (questionMarks > VAGUE_MAX_QUESTION_MARKS) return true;
  return false;
}

const QUESTIONS_BLOCK = /<questions>([\s\S]*?)<\/questions>/i;
const LEADING_BULLET = /^[-*\d.)\s]+/;

export function parseInterviewQuestions(output: string): string[] {
  const match = output.match(QUESTIONS_BLOCK);
  if (!match) return [];
  const body = match[1] ?? '';
  const cleaned = body
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => l.replace(LEADING_BULLET, '').trim())
    .filter((l) => l.length > 0);
  return cleaned.slice(0, 3);
}

export interface InterviewQuestion {
  index: number;
  text: string;
}

export interface InterviewPostRequest {
  taskId: string;
  issueNumber: number;
  repo: string;
  questions: string[];
}

export interface InterviewPostResult {
  channelId?: string;
  threadId?: string;
  messageId?: string;
}

// Posts the interview questions to the originating task thread (Discord) and
// returns enough metadata for the control plane / MCP reply handler to wire
// the answers back to the sprint. Errors are non-fatal — the pipeline still
// halts so an operator can be looped in out-of-band.
export interface InterviewPoster {
  post(input: InterviewPostRequest): Promise<InterviewPostResult>;
}
