import { exec } from "child_process";
import { promisify } from "util";
import { writeFile, rm, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { resolve, join, relative } from "path";
import type { ProjectConfig, ResolvedContext } from "./config.ts";
import type { TrelloCard, TrelloClient } from "./trello.ts";
import type { AgentDirectives, ParsedCard } from "./directives.ts";
import { logger } from "./logger.ts";

const execAsync = promisify(exec);

export class AgentWorker {
  private branchName: string;
  private worktreePath: string;
  private ctx: ResolvedContext;
  private directives: AgentDirectives;
  private description: string;

  constructor(
    private projectId: string,
    private config: ProjectConfig,
    private card: TrelloCard,
    private trello: TrelloClient,
    ctx: ResolvedContext,
    parsed: ParsedCard
  ) {
    this.ctx = ctx;
    this.directives = parsed.directives;
    this.description = parsed.description;

    const slug = card.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 50);

    this.branchName =
      parsed.directives.branch ?? `agent/${slug}-${card.id.slice(-6)}`;

    // Worktrees always live at repo root, not inside the package
    this.worktreePath = resolve(ctx.repoPath, ".worktrees", card.id);
  }

  // ─── Plan pass ─────────────────────────────────────────────────────────────

  async runPlanPass(): Promise<string> {
    logger.info(`[${this.projectId}] PLAN pass: "${this.card.name}"`);

    const prompt = this.buildPlanPrompt();

    // Plan pass runs from workingPath (package dir or repo root)
    const { stdout } = await execAsync(
      `claude --print --allowedTools "Read,Glob,Grep" "${escapeShell(prompt)}"`,
      {
        cwd: this.ctx.workingPath,
        timeout: 10 * 60 * 1000,
        maxBuffer: 10 * 1024 * 1024,
        env: { ...process.env },
      }
    );

    return stdout.trim();
  }

  // ─── Execute pass ───────────────────────────────────────────────────────────

  async runExecutePass(approvedPlan?: string): Promise<string> {
    logger.info(`[${this.projectId}] EXECUTE pass: "${this.card.name}"`);

    try {
      await this.setupWorktree();
      const prompt = this.buildExecutePrompt(approvedPlan);
      await this.invokeClaudeCode(prompt);
      const prUrl = await this.createPR();
      return prUrl;
    } finally {
      await this.cleanupWorktree();
    }
  }

  // ─── Worktree lifecycle ─────────────────────────────────────────────────────

  private async setupWorktree() {
    const worktreesDir = join(this.ctx.repoPath, ".worktrees");
    if (!existsSync(worktreesDir)) {
      await mkdir(worktreesDir, { recursive: true });
    }

    await this.git(`fetch origin ${this.ctx.baseBranch}`);
    await this.git(
      `worktree add -b "${this.branchName}" "${this.worktreePath}" origin/${this.ctx.baseBranch}`
    );

    logger.info(`[${this.projectId}] Worktree ready: ${this.branchName}`);
  }

  private async cleanupWorktree() {
    try {
      if (existsSync(this.worktreePath)) {
        await this.git(`worktree remove --force "${this.worktreePath}"`);
      }
    } catch (err: any) {
      logger.warn(`[${this.projectId}] Worktree cleanup failed: ${err.message}`);
    }
  }

  // ─── Prompt builders ────────────────────────────────────────────────────────

  private buildBaseContext(): string {
    const { card, ctx, directives } = this;

    // Monorepo scope header
    const scopeHeader = ctx.isMonorepo
      ? ctx.packageName === "root"
        ? `## Scope\nWorking at monorepo root: ${ctx.repoPath}`
        : `## Scope\nWorking in package: **${ctx.packageName}** (${relative(ctx.repoPath, ctx.workingPath)})\nRepo root: ${ctx.repoPath}`
      : "";

    const checklists =
      card.checklists && card.checklists.length > 0
        ? "\n\n## Checklist\n" +
          card.checklists
            .map(
              (cl) =>
                `### ${cl.name}\n` +
                cl.checkItems
                  .map((i) => `- [${i.state === "complete" ? "x" : " "}] ${i.name}`)
                  .join("\n")
            )
            .join("\n\n")
        : "";

    const contextHint =
      directives.context && directives.context.length > 0
        ? `\n\n## Suggested paths\n${directives.context.map((p) => `- ${p}`).join("\n")}`
        : "";

    const ignoreHint =
      directives.ignore && directives.ignore.length > 0
        ? `\n\n## Do NOT touch\n${directives.ignore.map((p) => `- ${p}`).join("\n")}`
        : "";

    return [
      scopeHeader,
      `## Task: ${card.name}`,
      "",
      "## Description",
      this.description || "(No description provided)",
      checklists,
      contextHint,
      ignoreHint,
      "",
      ctx.systemContext ? `## Project context\n${ctx.systemContext}` : "",
      "",
      `Trello card: ${card.url}`,
    ]
      .filter((s) => s !== null)
      .join("\n");
  }

  private buildPlanPrompt(): string {
    const thinking =
      this.directives.think === "deep"
        ? "Think deeply and consider edge cases, risks, and alternative approaches."
        : "Be concise and practical.";

    return `You are an autonomous coding agent in PLAN MODE. Do NOT write or edit any files.

${this.buildBaseContext()}

## Your job
${thinking}

Respond with a structured plan:

### Summary
One paragraph describing the approach.

### Files to change
- path/to/file — what and why

### Files to create
- path/to/new-file — what it contains

### Steps
1. ...

### Tests
How you will verify the changes.

### Risks / open questions
Any concerns or blockers.

Output ONLY the plan. No code.`;
  }

  private buildExecutePrompt(approvedPlan?: string): string {
    const { directives, ctx } = this;

    const thinkingInstruction =
      directives.think === "deep"
        ? "Think step by step before making any changes."
        : "";

    const personaInstruction =
      directives.persona === "creative"
        ? "You may propose a better solution than described if you have good reason — explain in the commit message."
        : "Follow the description precisely. Do not make unrequested changes.";

    const testsInstruction = {
      required: `Run \`${ctx.testCmd}\` before committing. Fix any failures.`,
      skip: "Skip running tests for this task.",
      "write-new": `Write new tests for your changes. Run \`${ctx.testCmd}\` before committing.`,
    }[directives.tests];

    // For monorepo: tell the agent explicitly where to work
    const workingDirInstruction = ctx.isMonorepo
      ? ctx.packageName === "root"
        ? `Your working directory is the monorepo root: ${ctx.repoPath}\nYou may touch files across packages if needed.`
        : `Your primary working directory is: ${ctx.workingPath}\nStay within this package unless the task explicitly requires cross-package changes.`
      : `Your working directory is: ${ctx.repoPath}`;

    const planSection = approvedPlan
      ? `\n\n## Approved implementation plan\nFollow this plan precisely:\n\n${approvedPlan}`
      : "";

    return `You are an autonomous coding agent. Complete the task and commit your changes.

${this.buildBaseContext()}${planSection}

## Working directory
${workingDirInstruction}

## Instructions
${thinkingInstruction}
${personaInstruction}

1. Understand the full scope of the task.
2. Make all necessary code changes.
3. ${testsInstruction}
4. Commit with message: "feat: ${this.card.name.replace(/"/g, "'")} [${this.card.id}]"
5. Do NOT push — the orchestrator handles that.

Branch: ${this.branchName}`;
  }

  // ─── Claude Code invocation ─────────────────────────────────────────────────

  private async invokeClaudeCode(prompt: string) {
    const promptFile = join(this.worktreePath, ".agent-prompt.md");

    // In a monorepo worktree, the working path is relative to worktree root
    const relativeWorkingPath = this.ctx.isMonorepo && this.ctx.packageName !== "root"
      ? relative(this.ctx.repoPath, this.ctx.workingPath)
      : ".";

    await writeFile(promptFile, prompt, "utf-8");

    logger.info(`[${this.projectId}] Invoking Claude Code (cwd: ${relativeWorkingPath})...`);

    const agentCwd = relativeWorkingPath === "."
      ? this.worktreePath
      : join(this.worktreePath, relativeWorkingPath);

    try {
      const { stdout, stderr } = await execAsync(
        `claude --print --allowedTools "Edit,Write,Bash,Read,Glob,Grep" "$(cat "${promptFile}")"`,
        {
          cwd: agentCwd,
          timeout: 30 * 60 * 1000,
          maxBuffer: 10 * 1024 * 1024,
          env: { ...process.env },
        }
      );

      if (stdout) logger.info(`[${this.projectId}] Claude:\n${stdout.slice(0, 2000)}`);
      if (stderr) logger.warn(`[${this.projectId}] Claude stderr: ${stderr.slice(0, 500)}`);
    } finally {
      await rm(promptFile, { force: true });
    }

    // Check for changes from worktree root (git sees the whole tree)
    const { stdout: statusOut } = await this.git(
      "status --porcelain",
      this.worktreePath
    );
    if (!statusOut.trim()) {
      throw new Error("Claude Code made no changes to commit.");
    }

    await this.git("add -A", this.worktreePath);
    await this.git(
      `commit -m "feat: ${this.card.name.replace(/"/g, "'")} [${this.card.id}]"`,
      this.worktreePath
    );

    logger.info(`[${this.projectId}] Committed on ${this.branchName}`);
  }

  // ─── PR creation ────────────────────────────────────────────────────────────

  private async createPR(): Promise<string> {
    if (this.directives.pr === "skip") {
      await this.git(`push origin "${this.branchName}"`, this.ctx.repoPath);
      return `(no PR — branch pushed: ${this.branchName})`;
    }

    await this.git(`push origin "${this.branchName}"`, this.ctx.repoPath);

    const scope = this.ctx.isMonorepo && this.ctx.packageName
      ? `[${this.ctx.packageName}] `
      : "";

    const prBody = [
      this.ctx.isMonorepo
        ? `**Package:** \`${this.ctx.packageName ?? "root"}\``
        : "",
      `**Trello card:** ${this.card.url}`,
      "",
      this.description || "",
      "",
      "---",
      "_Created autonomously by Night Crew._",
    ]
      .filter((l) => l !== null)
      .join("\n");

    const draftFlag = this.directives.pr === "draft" ? "--draft" : "";

    const { stdout } = await execAsync(
      `gh pr create ${draftFlag} \
        --base "${this.ctx.baseBranch}" \
        --head "${this.branchName}" \
        --title "${scope}${this.card.name.replace(/"/g, "'")}" \
        --body "${prBody.replace(/"/g, "'")}"`,
      { cwd: this.ctx.repoPath }
    );

    const prUrl = stdout.trim();
    logger.info(`[${this.projectId}] PR: ${prUrl}`);
    return prUrl;
  }

  // ─── Git helper ─────────────────────────────────────────────────────────────

  private async git(
    cmd: string,
    cwd?: string
  ): Promise<{ stdout: string; stderr: string }> {
    return execAsync(`git -C "${cwd ?? this.ctx.repoPath}" ${cmd}`);
  }
}

function escapeShell(str: string): string {
  return str.replace(/"/g, '\\"').replace(/`/g, "\\`").replace(/\$/g, "\\$");
}
