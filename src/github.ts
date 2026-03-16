import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

export async function checkGhCli(repoPath: string): Promise<void> {
  try {
    await execAsync("gh auth status", { cwd: repoPath });
  } catch {
    throw new Error(
      "GitHub CLI (gh) is not authenticated. Run: gh auth login"
    );
  }
}

export async function getPRForBranch(
  repoPath: string,
  branch: string
): Promise<string | null> {
  try {
    const { stdout } = await execAsync(
      `gh pr view "${branch}" --json url --jq .url`,
      { cwd: repoPath }
    );
    return stdout.trim() || null;
  } catch {
    return null;
  }
}
