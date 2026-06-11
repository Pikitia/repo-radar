import { spawn } from "node:child_process";

export type GitResult = {
  stdout: string;
  stderr: string;
  code: number;
};

export class GitCommandError extends Error {
  result: GitResult;

  constructor(message: string, result: GitResult) {
    super(message);
    this.name = "GitCommandError";
    this.result = result;
  }
}

export function runGit(cwd: string, args: string[], timeoutMs = 30000): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      shell: false,
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }
    });

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new GitCommandError(`git ${args.join(" ")} timed out`, { stdout, stderr, code: -1 }));
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const result = { stdout, stderr, code: code ?? -1 };
      if (result.code === 0) {
        resolve(result);
      } else {
        reject(new GitCommandError(`git ${args.join(" ")} failed`, result));
      }
    });
  });
}

export async function tryGit(cwd: string, args: string[], timeoutMs = 30000): Promise<GitResult> {
  try {
    return await runGit(cwd, args, timeoutMs);
  } catch (error) {
    if (error instanceof GitCommandError) {
      return error.result;
    }
    throw error;
  }
}
