import { existsSync } from "fs";
import { readFile } from "fs/promises";
import { resolve } from "path";

// ─── Monorepo package config ───────────────────────────────────────────────────

export interface MonoPackageConfig {
  /** Relative path from repo root, e.g. "apps/api" */
  path: string;
  /** Test command to run from within this package directory */
  testCmd?: string;
  /** Injected into agent prompt for this package */
  systemContext?: string;
}

// ─── Repo config ───────────────────────────────────────────────────────────────

export interface RepoConfig {
  path: string;
  baseBranch: string;
  /** Injected into every agent prompt for this repo */
  systemContext?: string;

  // ── Monorepo fields (all optional — omit for single-package repos) ──
  monorepo?: boolean;
  /** Named packages within the monorepo */
  packages?: Record<string, MonoPackageConfig>;
  /**
   * If true, cards targeting this repo MUST include a `package:` directive.
   * Agent errors with a helpful comment if missing. Default: false.
   */
  packageRequired?: boolean;
  /**
   * Packages that get serialized (max 1 concurrent agent) and extra
   * caution warnings injected into the prompt.
   */
  dangerousPackages?: string[];
  /** Test command to run from repo root (used for cross-package / root tasks) */
  rootTestCmd?: string;
}

// ─── Project config ────────────────────────────────────────────────────────────

export interface ProjectConfig {
  id: string;
  // Trello auth
  trelloApiKey: string;
  trelloToken: string;
  // Trello board lists
  trelloBoardId: string;
  queueListId: string;
  inProgressListId: string;
  planReviewListId: string;
  approvedListId: string;
  humanReviewListId: string;
  // Repos — keyed by alias used in card `repo:` directive
  repos: Record<string, RepoConfig>;
  // Fallback when no `repo:` directive present on card
  defaultRepo: string;
  // Max concurrent agents across all repos for this project
  maxConcurrent: number;
}

// ─── Resolved context ──────────────────────────────────────────────────────────

/**
 * Fully resolved working context for a single agent run.
 * Merges repo-level and package-level config into one flat object.
 */
export interface ResolvedContext {
  repoPath: string;
  baseBranch: string;
  /** Absolute path agent should treat as its working root */
  workingPath: string;
  /** Whether workingPath is a sub-package of a larger monorepo */
  isMonorepo: boolean;
  packageName?: string;
  /** Merged: repo systemContext + package systemContext */
  systemContext: string;
  /** Test command appropriate for the scope of this work */
  testCmd: string;
  /** True if this package is in dangerousPackages */
  isDangerous: boolean;
  /** All package names available (for error messages) */
  availablePackages?: string[];
}

// ─── Resolver ─────────────────────────────────────────────────────────────────

export function resolveContext(
  config: ProjectConfig,
  repoAlias?: string,
  packageAlias?: string
): ResolvedContext {
  const alias = repoAlias ?? config.defaultRepo;
  const repo = config.repos[alias];

  if (!repo) {
    const available = Object.keys(config.repos).join(", ");
    throw new Error(`Unknown repo alias "${alias}". Available: ${available}`);
  }

  const repoPath = resolve(repo.path);
  const availablePackages = repo.packages
    ? Object.keys(repo.packages)
    : undefined;

  // ── Non-monorepo ──
  if (!repo.monorepo) {
    return {
      repoPath,
      baseBranch: repo.baseBranch,
      workingPath: repoPath,
      isMonorepo: false,
      systemContext: repo.systemContext ?? "",
      testCmd: repo.rootTestCmd ?? "bun test",
      isDangerous: false,
    };
  }

  // ── Monorepo: require package if configured ──
  if (repo.packageRequired && !packageAlias) {
    const pkgList = availablePackages?.join(", ") ?? "none configured";
    throw new PackageRequiredError(
      `This is a monorepo and requires a \`package:\` directive.\n` +
        `Available packages: ${pkgList}\n` +
        `Add \`package: <name>\` to the agent block on your card.`
    );
  }

  // ── Monorepo: root-level work ──
  if (!packageAlias || packageAlias === "root") {
    return {
      repoPath,
      baseBranch: repo.baseBranch,
      workingPath: repoPath,
      isMonorepo: true,
      packageName: "root",
      systemContext: [repo.systemContext, "You are working at the monorepo root. Changes may affect multiple packages."]
        .filter(Boolean)
        .join("\n\n"),
      testCmd: repo.rootTestCmd ?? "bun test",
      isDangerous: false,
      availablePackages,
    };
  }

  // ── Monorepo: specific package ──
  const pkg = repo.packages?.[packageAlias];
  if (!pkg) {
    const pkgList = availablePackages?.join(", ") ?? "none configured";
    throw new Error(
      `Unknown package "${packageAlias}" in repo "${alias}".\nAvailable: ${pkgList}`
    );
  }

  const workingPath = resolve(repoPath, pkg.path);
  const isDangerous = repo.dangerousPackages?.includes(pkg.path) ?? false;

  const systemContextParts = [
    repo.systemContext,
    pkg.systemContext,
    isDangerous
      ? `⚠️  This package (${pkg.path}) is a shared dependency. Changes here affect all packages. Be conservative — do not change or remove existing exports without explicit instruction.`
      : null,
  ].filter(Boolean);

  return {
    repoPath,
    baseBranch: repo.baseBranch,
    workingPath,
    isMonorepo: true,
    packageName: packageAlias,
    systemContext: systemContextParts.join("\n\n"),
    testCmd: pkg.testCmd ?? repo.rootTestCmd ?? "bun test",
    isDangerous,
    availablePackages,
  };
}

/** Thrown when packageRequired=true and no package directive present */
export class PackageRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PackageRequiredError";
  }
}

// ─── Loader ───────────────────────────────────────────────────────────────────

export async function loadProjects(): Promise<ProjectConfig[]> {
  const configPath = resolve(process.cwd(), "projects.json");

  if (!existsSync(configPath)) {
    throw new Error(
      `projects.json not found at ${configPath}\nRun: cp projects.example.json projects.json`
    );
  }

  const raw = await readFile(configPath, "utf-8");
  const parsed = JSON.parse(raw);

  if (!Array.isArray(parsed)) {
    throw new Error("projects.json must be an array of project configs");
  }

  const required = [
    "id",
    "trelloApiKey",
    "trelloToken",
    "trelloBoardId",
    "queueListId",
    "inProgressListId",
    "planReviewListId",
    "approvedListId",
    "humanReviewListId",
    "repos",
    "defaultRepo",
  ] as const;

  return parsed.map((raw: any, i: number) => {
    for (const key of required) {
      if (!raw[key]) {
        throw new Error(`projects.json[${i}] missing required field: "${key}"`);
      }
    }

    if (!raw.repos[raw.defaultRepo]) {
      throw new Error(
        `projects.json[${i}] defaultRepo "${raw.defaultRepo}" not found in repos`
      );
    }

    return {
      ...raw,
      maxConcurrent: raw.maxConcurrent ?? 2,
    } as ProjectConfig;
  });
}
