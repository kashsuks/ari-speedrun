// Shapes of the Ari reviewer payloads (only the fields this app reads) and of our analysis.

export interface AriProgram {
  id: string;
  name: string;
  color: string;
  iconUrl: string | null;
  pending: number;
  member: boolean;
}

export interface AriQueueRow {
  id: string;
  title: string;
  author: string;
  authorSlackId: string | null;
  evidenceSeconds: number;
  status: string;
  track: "software" | "hardware";
  ago: string;
  thumb: string | null;
  priority: boolean;
  isUpdate: boolean;
  claim: { mine: boolean; byName: string } | null;
}

export interface AriCommit {
  id: string;
  hash: string;
  message: string;
  committedAt: string;
  additions: number;
  deletions: number;
  codingSeconds: number;
  htSeen: boolean;
  people: { label: string; slackId: string | null; matched: boolean }[];
}

export interface AriWarning {
  id: string;
  kind: string; // FRAUD, DOUBLE_DIP, ...
  severity: string;
  title: string;
  what: string;
  action: string;
  matched: { key: string; value: string }[];
}

export interface AriPastProject {
  programs: string[];
  codeUrl: string | null;
  playableUrl: string | null;
  description: string | null;
  hackatimeProjects: string[];
  creditedSeconds: number;
  approvedAt: string | null;
}

export interface AriPastReview {
  shipId: string;
  version: number;
  decision: string;
  reviewerName: string;
  when: string;
  approvedSeconds: number;
  note: string;
  audit: string;
}

export interface AriReview {
  ship: {
    id: string;
    projectId: string;
    title: string;
    description: string;
    author: string;
    authorSlackId: string | null;
    status: string;
    ingestVersion: number;
    version: number;
    track: "software" | "hardware";
    repoUrl: string;
    extraRepoUrls: string[];
    demoUrl: string | null;
    thumbnailUrl: string | null;
    meta: Record<string, string>;
    receivedAt: string;
    priority: boolean;
  };
  collaborators: unknown[] | null;
  makers: { name: string; email: string; slackId: string | null; hackatimeUserId: string | null }[];
  hackatimeProjects: { name: string; seconds: number | null }[];
  fileHours: { path: string; seconds: number; status: string }[];
  pastProjects: AriPastProject[];
  evidence: {
    commits: AriCommit[];
    devlogs: { at?: string; seconds?: number; text?: string }[];
    clips: { at: string; lengthSeconds: number; note: string | null; url: string }[];
  };
  hours: {
    hackatimeSeconds: number;
    devlogSeconds: number;
    lapseSeconds: number;
    afterLastCommitSeconds: number;
    programSeconds: number;
    aiDiscountedSeconds: number;
  };
  rules: { hoursJustification: boolean; allowDeflation: boolean };
  update: { message: string } | null;
  warnings: AriWarning[];
  snapshot: { version: number; synced: boolean; issue: string | null };
  checklist: { label: string }[];
  fixes: { reviewId: string; note: string; audit: string; reviewerName: string; when: string }[];
  snippets: { id: string; name: string; body: string }[];
  customFields: { key: string; label: string; type: string; description: string; required: boolean; options: string[] }[];
  pastReviews: AriPastReview[];
  lock: { claimable: boolean; mine: boolean; readOnly: boolean; byName: string | null };
  viewer: { canReview: boolean };
  state: { decided: boolean; closed: boolean };
  privatePanels?: { hackatime?: { days?: Record<string, Record<string, number>> } };
}

export type Level = "pass" | "warn" | "fail" | "unknown";

export interface Check {
  level: Level;
  summary: string;
  details?: string[];
}

export interface GithubInfo {
  owner: string;
  repo: string;
  description: string | null;
  stars: number;
  fork: boolean;
  createdAt: string | null;
  pushedAt: string | null;
  languages: Record<string, number>;
  topLevel: string[];
  fileCount: number | null;
  readmeMarkdown: string | null;
}

export interface DemoProbe {
  url: string | null;
  finalUrl: string | null;
  status: number | null;
  contentType: string | null;
  kind: string; // live-site | video | release | store | source-only | download | broken | missing | other
  title: string | null;
  textSample: string | null;
  releaseAssets: string[];
}

export interface AiVerdict {
  recommendation: "approve" | "changes" | "reject";
  confidence: "high" | "medium" | "low";
  readme: { aiGenerated: "likely" | "possibly" | "unlikely"; reasoning: string };
  demo: { usable: boolean; reasoning: string };
  hackatimeRelated: { related: boolean; reasoning: string };
  commits: { healthy: boolean; reasoning: string };
  summary: string;
  stack: string;
  noteToMaker: string;
  auditNote: string;
  technicalFeatures: string;
  returnReason: string;
  changeInstructions: string;
}

export interface Analysis {
  shipId: string;
  programId: string;
  ingestVersion: number;
  snapshotVersion: number;
  analyzedAt: string;
  queue: AriQueueRow;
  review: AriReview;
  github: GithubInfo | null;
  demo: DemoProbe;
  checks: {
    readme: Check;
    demo: Check;
    doubleDip: Check;
    fraud: Check;
    commits: Check;
    hackatime: Check;
  };
  commitStats: CommitStats;
  ai: AiVerdict | null;
  aiError: string | null;
}

export interface CommitStats {
  total: number;
  activeDays: number;
  spanDays: number;
  firstAt: string | null;
  lastAt: string | null;
  largestGapDays: number;
  unmatchedAuthors: number;
  lowEffortMessages: number;
  biggestCommitShare: number; // share of coding seconds in the single biggest commit
  perDay: Record<string, number>;
}
