export interface AgentDirectives {
  mode: "gsd" | "plan" | "plan-execute" | "careful";
  repo?: string;
  package?: string; // monorepo package alias, e.g. "web", "api", "shared", or "root"
  context?: string[];
  ignore?: string[];
  tests: "required" | "skip" | "write-new";
  concurrency: "solo" | "exclusive" | "low";
  maxAttempts: number;
  onFailure: "queue" | "notify";
  pr: "draft" | "ready" | "skip";
  branch?: string;
  think: "fast" | "deep";
  persona: "strict" | "creative";
}

export const DEFAULTS: AgentDirectives = {
  mode: "gsd",
  tests: "required",
  concurrency: "solo",
  maxAttempts: 1,
  onFailure: "queue",
  pr: "draft",
  think: "fast",
  persona: "strict",
};

export interface ParsedCard {
  directives: AgentDirectives;
  description: string;
}

export function parseDirectives(cardDesc: string): ParsedCard {
  const match = cardDesc.match(/^```agent\n([\s\S]*?)\n```/);

  if (!match) {
    return { directives: { ...DEFAULTS }, description: cardDesc.trim() };
  }

  const block = match[1];
  const description = cardDesc.slice(match[0].length).trim();
  const overrides: Partial<AgentDirectives> = {};

  for (const line of block.split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;

    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    if (!key || !value) continue;

    switch (key) {
      case "mode":         overrides.mode = value as AgentDirectives["mode"]; break;
      case "repo":         overrides.repo = value; break;
      case "package":      overrides.package = value; break;
      case "tests":        overrides.tests = value as AgentDirectives["tests"]; break;
      case "concurrency":  overrides.concurrency = value as AgentDirectives["concurrency"]; break;
      case "max-attempts": overrides.maxAttempts = parseInt(value, 10); break;
      case "on-failure":   overrides.onFailure = value as AgentDirectives["onFailure"]; break;
      case "pr":           overrides.pr = value as AgentDirectives["pr"]; break;
      case "branch":       overrides.branch = value; break;
      case "think":        overrides.think = value as AgentDirectives["think"]; break;
      case "persona":      overrides.persona = value as AgentDirectives["persona"]; break;
      case "context":      overrides.context = value.split(",").map((s) => s.trim()); break;
      case "ignore":       overrides.ignore = value.split(",").map((s) => s.trim()); break;
    }
  }

  return { directives: { ...DEFAULTS, ...overrides }, description };
}
