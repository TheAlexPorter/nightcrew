import { loadProjects, resolveContext, PackageRequiredError } from "./config.ts";
import type { ProjectConfig, ResolvedContext } from "./config.ts";
import { TrelloClient } from "./trello.ts";
import type { TrelloCard } from "./trello.ts";
import { AgentWorker } from "./agent.ts";
import { parseDirectives } from "./directives.ts";
import type { AgentDirectives } from "./directives.ts";
import { logger } from "./logger.ts";

const POLL_INTERVAL_MS = 120_000; // 2 minutes

// ─── Job tracking ──────────────────────────────────────────────────────────────

interface ActiveJob {
  projectId: string;
  cardId: string;
  repoAlias: string;
  packageName?: string; // resolved package name (for dangerous package tracking)
  isApprovedPass: boolean;
}

const activeJobs = new Map<string, ActiveJob>();

function jobKey(projectId: string, cardId: string, approved = false) {
  return `${projectId}:${cardId}${approved ? ":approved" : ""}`;
}

function countActiveForProject(projectId: string): number {
  let n = 0;
  for (const job of activeJobs.values()) {
    if (job.projectId === projectId && !job.isApprovedPass) n++;
  }
  return n;
}

/**
 * Returns true if a dangerous package is already being worked on
 * in this project by another agent.
 */
function isDangerousPackageLocked(
  projectId: string,
  repoAlias: string,
  packageName: string
): boolean {
  for (const job of activeJobs.values()) {
    if (
      job.projectId === projectId &&
      job.repoAlias === repoAlias &&
      job.packageName === packageName
    ) {
      return true;
    }
  }
  return false;
}

// ─── Main poll ────────────────────────────────────────────────────────────────

async function pollProject(config: ProjectConfig, trello: TrelloClient) {
  const { id } = config;

  // ── Stage 1: Queue → dispatch ──
  const slots = config.maxConcurrent - countActiveForProject(id);
  if (slots > 0) {
    const queued = await trello.getCardsInList(config.queueListId);
    let dispatched = 0;

    for (const card of queued) {
      if (dispatched >= slots) break;
      const didDispatch = dispatchFromQueue(config, trello, card);
      if (didDispatch) dispatched++;
    }

    if (queued.length === 0) {
      logger.info(`[${id}] Queue empty`);
    } else if (dispatched === 0) {
      logger.info(`[${id}] All ${config.maxConcurrent} slots busy`);
    } else {
      logger.info(`[${id}] Dispatched ${dispatched} card(s)`);
    }
  } else {
    logger.info(`[${id}] All ${config.maxConcurrent} slots busy`);
  }

  // ── Stage 2: Approved → execute (plan-execute second pass) ──
  const approved = await trello.getCardsInList(config.approvedListId);
  for (const card of approved) {
    dispatchApproved(config, trello, card);
  }
}

// ─── Dispatch: Queue ──────────────────────────────────────────────────────────

function dispatchFromQueue(
  config: ProjectConfig,
  trello: TrelloClient,
  card: TrelloCard
): boolean {
  const key = jobKey(config.id, card.id);
  if (activeJobs.has(key)) return false;

  const parsed = parseDirectives(card.desc ?? "");
  const { directives } = parsed;

  let ctx: ResolvedContext;
  try {
    ctx = resolveContext(config, directives.repo, directives.package);
  } catch (err: any) {
    const isPackageRequired = err instanceof PackageRequiredError;
    logger.error(`[${config.id}] "${card.name}": ${err.message}`);
    trello.addComment(
      card.id,
      isPackageRequired
        ? `⚠️ **Package required**\n\n${err.message}`
        : `❌ Config error: ${err.message}`
    );
    return false;
  }

  // Serialize dangerous packages — skip for now, retry next poll
  if (ctx.isDangerous && isDangerousPackageLocked(config.id, directives.repo ?? config.defaultRepo, ctx.packageName!)) {
    logger.info(
      `[${config.id}] "${card.name}": package "${ctx.packageName}" is locked (dangerous). Will retry next poll.`
    );
    return false;
  }

  const repoAlias = directives.repo ?? config.defaultRepo;
  activeJobs.set(key, {
    projectId: config.id,
    cardId: card.id,
    repoAlias,
    packageName: ctx.packageName,
    isApprovedPass: false,
  });

  logger.info(
    `[${config.id}] "${card.name}" → mode:${directives.mode} repo:${repoAlias}${ctx.packageName ? ` pkg:${ctx.packageName}` : ""}`
  );

  const worker = new AgentWorker(config.id, config, card, trello, ctx, parsed);

  const run =
    directives.mode === "plan" || directives.mode === "plan-execute"
      ? () => runPlanPass(config, trello, card, worker)
      : () => runExecutePass(config, trello, card, worker);

  runWithRetry(run, directives.maxAttempts, async (err) => {
    await handleFailure(config, trello, card, directives, err);
  }).finally(() => activeJobs.delete(key));

  return true;
}

// ─── Dispatch: Approved ───────────────────────────────────────────────────────

function dispatchApproved(
  config: ProjectConfig,
  trello: TrelloClient,
  card: TrelloCard
) {
  const key = jobKey(config.id, card.id, true);
  if (activeJobs.has(key)) return;

  const parsed = parseDirectives(card.desc ?? "");
  const { directives } = parsed;

  let ctx: ResolvedContext;
  try {
    ctx = resolveContext(config, directives.repo, directives.package);
  } catch (err: any) {
    logger.error(`[${config.id}] Approved card "${card.name}": ${err.message}`);
    return;
  }

  const repoAlias = directives.repo ?? config.defaultRepo;
  activeJobs.set(key, {
    projectId: config.id,
    cardId: card.id,
    repoAlias,
    packageName: ctx.packageName,
    isApprovedPass: true,
  });

  const worker = new AgentWorker(config.id, config, card, trello, ctx, parsed);

  trello
    .getLatestPlanComment(card.id)
    .then((plan) =>
      runWithRetry(
        () => runExecutePass(config, trello, card, worker, plan ?? undefined),
        directives.maxAttempts,
        async (err) => handleFailure(config, trello, card, directives, err)
      )
    )
    .finally(() => activeJobs.delete(key));
}

// ─── Plan pass ────────────────────────────────────────────────────────────────

async function runPlanPass(
  config: ProjectConfig,
  trello: TrelloClient,
  card: TrelloCard,
  worker: AgentWorker
) {
  await trello.moveCard(card.id, config.inProgressListId);
  await trello.addComment(card.id, `🤖 Planning...`);

  const plan = await worker.runPlanPass();

  await trello.addComment(
    card.id,
    [
      "## 🤖 Proposed Implementation Plan",
      "",
      plan,
      "",
      "---",
      "_Move to **Approved** to execute, or edit the card and re-queue._",
    ].join("\n")
  );

  await trello.moveCard(card.id, config.planReviewListId);
  logger.info(`[${config.id}] ✅ Plan written: "${card.name}"`);
}

// ─── Execute pass ─────────────────────────────────────────────────────────────

async function runExecutePass(
  config: ProjectConfig,
  trello: TrelloClient,
  card: TrelloCard,
  worker: AgentWorker,
  approvedPlan?: string
) {
  await trello.moveCard(card.id, config.inProgressListId);
  await trello.addComment(card.id, `🤖 Agent working...`);

  const prUrl = await worker.runExecutePass(approvedPlan);

  await trello.moveCard(card.id, config.humanReviewListId);
  await trello.addComment(
    card.id,
    `✅ Done.\n\n**Pull Request:** ${prUrl}\n\nReady for human review.`
  );

  logger.info(`[${config.id}] ✅ PR: "${card.name}" → ${prUrl}`);
}

// ─── Failure handling ─────────────────────────────────────────────────────────

async function handleFailure(
  config: ProjectConfig,
  trello: TrelloClient,
  card: TrelloCard,
  directives: AgentDirectives,
  err: Error
) {
  logger.error(`[${config.id}] ❌ Failed: "${card.name}" — ${err.message}`);

  await trello.addComment(
    card.id,
    [
      `❌ Agent failed after ${directives.maxAttempts} attempt(s):`,
      "```",
      err.message.slice(0, 1000),
      "```",
      directives.onFailure === "queue"
        ? "\nCard moved back to **Queue**."
        : "\n⚠️ Card left in **In Progress** for manual inspection.",
    ].join("\n")
  );

  if (directives.onFailure === "queue") {
    await trello.moveCard(card.id, config.queueListId);
  }
}

// ─── Retry ────────────────────────────────────────────────────────────────────

async function runWithRetry(
  fn: () => Promise<void>,
  maxAttempts: number,
  onFinalFailure: (err: Error) => Promise<void>
) {
  let lastErr: Error | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await fn();
      return;
    } catch (err: any) {
      lastErr = err;
      if (attempt < maxAttempts) {
        logger.warn(`Attempt ${attempt}/${maxAttempts} failed, retrying in ${attempt * 5}s...`);
        await sleep(5_000 * attempt);
      }
    }
  }

  await onFinalFailure(lastErr!);
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Entry point ──────────────────────────────────────────────────────────────

async function runDaemon() {
  logger.info("🌙 Night Crew starting...");

  const projects = await loadProjects();
  logger.info(`Loaded ${projects.length} project(s)`);

  for (const p of projects) {
    const repoSummary = Object.entries(p.repos)
      .map(([alias, repo]) => {
        const pkgs = repo.monorepo && repo.packages
          ? ` (${Object.keys(repo.packages).join(", ")})`
          : "";
        return `${alias}${pkgs}`;
      })
      .join(" | ");
    logger.info(`[${p.id}] Repos: ${repoSummary} — default: ${p.defaultRepo}`);
  }

  async function tick() {
    for (const project of projects) {
      const trello = new TrelloClient(project.trelloApiKey, project.trelloToken);
      try {
        await pollProject(project, trello);
      } catch (err: any) {
        logger.error(`[${project.id}] Poll error: ${err.message}`);
      }
    }
  }

  await tick();
  setInterval(tick, POLL_INTERVAL_MS);
  logger.info(`⏱️  Polling every ${POLL_INTERVAL_MS / 1000}s. Ctrl+C to stop.`);
}

runDaemon().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
