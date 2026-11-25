import { lstat, mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runGit, tryGit } from "./exec.js";
import { mergeOptionWords } from "./syncPull.js";

// Leave room for quoting and the executable path on the Windows command line.
function* argumentBatches(values: Set<string>, prefixLength = 0) {
  let batch: string[] = [];
  let length = 0;
  for (const value of values) {
    const cost = value.length + prefixLength + 4;
    if (length + cost > 12000 && batch.length) {
      yield batch;
      batch = [];
      length = 0;
    }
    batch.push(value);
    length += cost;
  }
  if (batch.length) yield batch;
}

function protect(file: string, kind: "ignored" | "untracked"): never {
  throw new Error(`Sync would overwrite ${kind} local data at ${file}. Move it somewhere safe, then retry Sync.`);
}

type Targets = Map<string, { mayReplaceDirectory: boolean }>;

async function windowsDiskPath(root: string, file: string, link: boolean) {
  const full = path.join(root, file);
  let physical: string;
  if (link) {
    // Resolve the parent only. A junction or symlink can point outside the repository.
    const parent = await realpath(path.dirname(full));
    const requested = path.basename(full);
    const names = await readdir(parent);
    let actual = names.includes(requested) ? requested : undefined;
    if (!actual) {
      const requestedLink = await lstat(full, { bigint: true });
      const matches: string[] = [];
      for (const name of names.filter(name => name.toUpperCase() === requested.toUpperCase())) {
        const entry = await lstat(path.join(parent, name), { bigint: true });
        if (entry.isSymbolicLink() && entry.dev === requestedLink.dev && entry.ino === requestedLink.ino) matches.push(name);
      }
      if (matches.length === 1) actual = matches[0];
    }
    if (!actual) throw new Error(`Could not verify the on-disk name of ${file}. Refresh before syncing.`);
    physical = path.join(parent, actual);
  } else {
    physical = await realpath(full);
  }
  const relative = path.relative(root, physical);
  if (!relative || path.isAbsolute(relative) || relative === ".." || relative.startsWith(".." + path.sep)) {
    throw new Error(`The location of ${file} changed. Refresh before syncing.`);
  }
  return relative.split(path.sep).join("/");
}

async function hasUntrackedData(repo: string) {
  // Without exclusion rules Git also lists ignored entries, collapsing untracked directories.
  return Boolean((await runGit(repo, ["ls-files", "--others", "--directory", "-z"])).stdout);
}

async function checkLocalPaths(repo: string, targets: Targets, includeUntracked: boolean) {
  const paths = new Set<string>();
  const directories = new Set<string>();
  const links = new Set<string>();
  const kinds = new Map<string, "directory" | "file" | "absent">();
  for (const [target, { mayReplaceDirectory }] of targets) {
    const parts = target.split("/");
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      let kind = kinds.get(current);
      if (!kind) {
        const stat = await lstat(path.join(repo, current)).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
          return null;
        });
        kind = !stat ? "absent" : stat.isDirectory() ? "directory" : "file";
        if (stat?.isSymbolicLink()) links.add(current);
        kinds.set(current, kind);
      }
      if (kind === "absent") break;
      if (kind === "file") {
        // A file (including a symlink) can also block an incoming directory above the target.
        paths.add(current);
        break;
      }
      if (current === target && mayReplaceDirectory) {
        paths.add(current);
        directories.add(current);
      }
    }
  }

  if (!paths.size) return;
  if (process.platform === "win32") {
    // Git's icase pathspec does not fold every Unicode character that NTFS does.
    const root = await realpath(repo);
    for (const file of [...paths]) {
      const physical = await windowsDiskPath(root, file, links.has(file));
      if (physical === file) continue;
      paths.delete(file);
      paths.add(physical);
      if (directories.delete(file)) directories.add(physical);
    }
  }
  for (const batch of argumentBatches(paths)) {
    // A ./ prefix keeps filenames beginning with ':' out of Git's pathspec-magic syntax.
    const result = await tryGit(repo, ["-c", "core.quotePath=false", "check-ignore", "--", ...batch.map(file => `./${file}`)]);
    if (result.code === 0) protect(result.stdout.split(/\r?\n/)[0], "ignored");
    if (result.code !== 1) throw new Error(result.stderr.trim() || "Could not check for ignored files before Sync.");
  }
  // An earlier commit in a replay can change the ignore rules. Protect all
  // untracked data in its path. Leave ordinary checkout refusals to the save dialog.
  for (const batch of argumentBatches(includeUntracked ? paths : directories)) {
    const options = includeUntracked ? [] : ["--ignored", "--exclude-standard"];
    const others = await runGit(repo, ["--literal-pathspecs", "ls-files", "--others", ...options, "-z", "--", ...batch]);
    if (others.stdout) protect(others.stdout.split("\0")[0], includeUntracked ? "untracked" : "ignored");
  }
}

function directoryOf(file: string) {
  const slash = file.lastIndexOf("/");
  return slash < 0 ? "" : file.slice(0, slash);
}

async function previewMergeTree(repo: string, remoteTip: string) {
  const drivers = await tryGit(repo, ["config", "--name-only", "--null", "--get-regexp", "^merge\\..*\\.driver$"]);
  if (drivers.code !== 0 && drivers.code !== 1) throw new Error(drivers.stderr.trim() || "Could not read the repository’s merge drivers.");
  // Only the checkout paths are needed here. Git's built-in file merge can
  // compute a preview without opening or running a user's custom driver twice.
  const config: string[] = [];
  for (const key of new Set(drivers.stdout.split("\0").filter(Boolean))) {
    config.push("-c", `${key}=git merge-file -- %A %O %B`);
  }
  return tryGit(repo, [...config, "merge-tree", "--write-tree", "--allow-unrelated-histories", "-z", "HEAD", remoteTip]);
}

const ffOptions = ["--ff", "--no-ff", "--ff-only"];

async function mergeStrategies(repo: string) {
  const ref = (await runGit(repo, ["symbolic-ref", "--quiet", "HEAD"])).stdout.trimEnd();
  if (!ref.startsWith("refs/heads/")) throw new Error("Choose a branch before previewing this merge.");
  const branch = ref.slice("refs/heads/".length);
  const [branchConfig, twoHead] = await Promise.all([
    tryGit(repo, ["config", "--get", `branch.${branch}.mergeOptions`]), tryGit(repo, ["config", "--get", "pull.twohead"])
  ]);
  for (const result of [branchConfig, twoHead]) {
    if (result.code !== 0 && result.code !== 1) throw new Error(result.stderr.trim() || "Could not read the merge strategy.");
  }
  const words = mergeOptionWords(branchConfig.stdout.trimEnd());
  const strategies: string[] = [];
  const options: string[] = [];
  const branchFf: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    let option: string;
    let attached: string;
    if (word.startsWith("--")) {
      option = word.split("=", 1)[0];
      attached = word.slice(option.length + 1);
      if (ffOptions.includes(word)) {
        branchFf.push(word);
        continue;
      }
      if (["--message", "--file", "--into-name", "--cleanup"].includes(option)) {
        if (!word.includes("=")) i++;
        continue;
      }
      if (option !== "--strategy" && option !== "--strategy-option") {
        if (["--strategy-option", "--no-strategy-option", ...ffOptions].some(name => name.startsWith(option))) {
          throw new Error(`Use the full merge option name in branch.${branch}.mergeOptions before syncing.`);
        }
        continue;
      }
    } else {
      // Git permits packed short flags such as -nXsubtree=vendor and -nsours.
      const short = /^-[neqv]*([sXmFS])(.*)$/.exec(word);
      if (!short) {
        if (!/^-[neqv]+$/.test(word)) throw new Error(`Could not preview merge option “${word}”. Use its full name before syncing.`);
        continue;
      }
      option = short[1];
      attached = short[2];
      if (option === "S") continue; // Optional signing key is attached to this flag.
      if (option === "m" || option === "F") {
        if (!attached) i++;
        continue;
      }
    }
    const value = attached || words[++i];
    if (!value) throw new Error(`Missing value for merge option ${word}.`);
    (option === "s" || option === "--strategy" ? strategies : options).push(value);
  }
  // pull.twohead is a list of strategy names, unlike the shell-quoted branch options.
  if (!strategies.length) strategies.push(...twoHead.stdout.trim().split(/ +/).filter(Boolean));
  return { strategies, options, branchFf };
}

// merge-tree on older Git cannot accept strategy options. Use Git's actual
// built-in strategy in a disposable sparse checkout. Only its index is needed.
async function checkStrategyMerge(repo: string, remoteTip: string, strategies: string[], options: string[], ff: string[]) {
  if (strategies.some(name => !["ort", "recursive", "subtree", "ours", "resolve", "octopus"].includes(name))) {
    throw new Error("Repo Radar cannot preview this external merge strategy with local untracked or ignored files. Preserve those files before merging in Git.");
  }
  const [head, objects, format, settings] = await Promise.all([
    runGit(repo, ["rev-parse", "HEAD"]), runGit(repo, ["rev-parse", "--path-format=absolute", "--git-path", "objects"]),
    runGit(repo, ["rev-parse", "--show-object-format"]),
    tryGit(repo, ["config", "-z", "--get-regexp", "^(merge\\.(ff|directoryrenames|renames|renamelimit|renormalize)|diff\\.(renames|renamelimit)|core\\.(ignorecase|filemode|autocrlf|eol|symlinks|precomposeunicode))$"])
  ]);
  if (settings.code !== 0 && settings.code !== 1) throw new Error(settings.stderr.trim() || "Could not read merge settings.");
  const temp = await mkdtemp(path.join(os.tmpdir(), "repo-radar-merge-preview-"));
  const dir = path.join(temp, ".git");
  const env = { GIT_DIR: dir, GIT_COMMON_DIR: dir, GIT_WORK_TREE: temp, GIT_INDEX_FILE: path.join(dir, "index"),
    GIT_OBJECT_DIRECTORY: path.join(dir, "objects"), GIT_ALTERNATE_OBJECT_DIRECTORIES: "", GIT_CONFIG_COUNT: "0",
    GIT_CONFIG_PARAMETERS: "", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(temp, "empty-config"), GIT_ATTR_NOSYSTEM: "1" };
  const config = ["-c", "core.sparseCheckout=true", "-c", "core.sparseCheckoutCone=false", "-c", "user.name=Repo Radar", "-c", "user.email=repo-radar@localhost"];
  for (const entry of settings.stdout.split("\0").filter(Boolean)) config.push("-c", entry.replace("\n", "="));
  try {
    await runGit(temp, ["init", "--quiet", "--template=", `--object-format=${format.stdout.trim()}`], 30000, env);
    await mkdir(path.join(dir, "info"), { recursive: true });
    await writeFile(path.join(dir, "objects", "info", "alternates"), objects.stdout.trimEnd() + "\n");
    await writeFile(path.join(dir, "info", "sparse-checkout"), "/.git\n");
    await runGit(temp, [...config, "update-ref", "--no-deref", "HEAD", head.stdout.trim()], 30000, env);
    await runGit(temp, [...config, "read-tree", "-mu", "HEAD"], 30000, env);
    const args = ["merge", "--no-edit", "--no-commit", "--allow-unrelated-histories", ...ff];
    for (const strategy of strategies) args.push("-s", strategy);
    for (const option of options) args.push("-X", option);
    const merge = await tryGit(temp, [...config, ...args, "--", remoteTip], 60000, env);
    if (merge.code !== 0 && (merge.code !== 1 || !(await runGit(temp, ["ls-files", "-u", "-z"], 30000, env)).stdout)) {
      throw new Error(`Git could not preview the configured merge safely. ${merge.stderr.trim() || merge.stdout.trim()}`);
    }
    // The preview may fast-forward its own HEAD. Compare against the original checkout.
    const diff = await runGit(temp, [...config, "diff", "--cached", "--raw", "-z", "--no-renames", "--diff-filter=AMTU", head.stdout.trim(), "--"], 30000, env);
    await checkLocalPaths(repo, targetsFromDiff(diff.stdout), false);
  } finally {
    await rm(temp, { recursive: true, force: true, maxRetries: 3 });
  }
}

async function addRelocatedReplayPaths(repo: string, targets: Targets, original: string, destination?: string) {
  // During a cherry-pick, Git can move an addition to a directory renamed
  // on the destination branch. On resume, include the current index resolutions.
  const refs = destination ? [original, destination] : ["--cached", original];
  const renamed = await runGit(repo, ["diff", "--name-status", "-z", "--find-renames", "--diff-filter=R", ...refs, "--"]);
  if (!renamed.stdout) return;
  const fields = renamed.stdout.split("\0");
  const moved = new Map<string, Set<string>>();
  for (let i = 0; i + 2 < fields.length; i += 3) {
    let from = directoryOf(fields[i + 1]);
    let to = directoryOf(fields[i + 2]);
    while (from && from !== to) {
      const destinations = moved.get(from) ?? new Set<string>();
      destinations.add(to);
      moved.set(from, destinations);
      // old/sub/file -> new/sub/file also supplies evidence for old -> new.
      if (!to || path.posix.basename(from) !== path.posix.basename(to)) break;
      from = directoryOf(from);
      to = directoryOf(to);
    }
  }
  const candidates = new Map<string, Set<string>>();
  for (const file of targets.keys()) {
    for (let dir = directoryOf(file); dir; dir = directoryOf(dir)) {
      const destinations = moved.get(dir);
      if (!destinations) continue;
      const paths = candidates.get(dir) ?? new Set<string>();
      for (const to of destinations) paths.add(path.posix.join(to, file.slice(dir.length + 1)));
      candidates.set(dir, paths);
    }
  }
  for (const [dir, paths] of candidates) {
    // Git keeps additions in the original directory if the directory still exists there.
    const tree = destination
      ? await runGit(repo, ["--literal-pathspecs", "ls-tree", "-d", "-z", destination, "--", dir])
      : await runGit(repo, ["--literal-pathspecs", "ls-files", "--cached", "-z", "--", dir + "/"]);
    if (!tree.stdout) for (const file of paths) targets.set(file, { mayReplaceDirectory: true });
  }
}

async function addReplayConflictPaths(repo: string, targets: Targets, destination: string | undefined, commitLabels: Set<string>) {
  // When a pick needs a file and the other side needs a directory at the same
  // path, Git moves the file to path~<side>. These names are absent from the diff.
  const checkout = await runGit(repo, destination
    ? ["ls-tree", "-r", "--name-only", "-z", destination]
    : ["ls-files", "--cached", "-z"]);
  const files = new Set(checkout.stdout.split("\0").filter(Boolean));
  const directories = new Set<string>();
  for (const file of files) {
    for (let dir = directoryOf(file); dir && !directories.has(dir); dir = directoryOf(dir)) directories.add(dir);
  }
  const conflicts = new Map<string, Set<string>>();
  for (const file of targets.keys()) {
    if (directories.has(file)) conflicts.set(file, commitLabels);
    for (let dir = directoryOf(file); dir; dir = directoryOf(dir)) {
      if (files.has(dir)) conflicts.set(dir, new Set(["HEAD"]));
    }
  }
  if (!conflicts.size) return;
  // Check existing siblings so numbered alternatives and differing Windows
  // casing are covered without treating unrelated backups as blockers.
  const root = await realpath(repo);
  const siblings = new Map<string, string[]>();
  const normalize = (value: string) => process.platform === "win32" ? value.toUpperCase() : value;
  for (const [file, labels] of conflicts) {
    const dir = directoryOf(file);
    let names = siblings.get(dir);
    if (!names) {
      const parent = await realpath(path.join(root, dir)).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
        throw error;
      });
      if (!parent) continue;
      const relative = path.relative(root, parent);
      if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(".." + path.sep)) continue;
      names = await readdir(parent, { encoding: "utf8" });
      siblings.set(dir, names);
    }
    const prefix = normalize(path.posix.basename(file) + "~");
    const suffixes = new Set([...labels].map(normalize));
    for (const name of names) {
      const folded = normalize(name);
      if (!folded.startsWith(prefix)) continue;
      const suffix = folded.slice(prefix.length);
      if (suffixes.has(suffix) || suffixes.has(suffix.replace(/_\d+$/, ""))) {
        targets.set(path.posix.join(dir, name), { mayReplaceDirectory: true });
      }
    }
  }
}

async function checkReplayPaths(repo: string, revisions: string[], destination?: string) {
  const [log, parents] = await Promise.all([
    runGit(repo, ["log", "--root", "--format=", "--name-only", "-z", "--no-renames", "--diff-filter=AMT", ...revisions, "--"]),
    runGit(repo, ["log", "--no-merges", "--no-show-signature", "-z", "--format=%P%x00%h%x00%B", ...(destination ? ["--topo-order", "--reverse"] : []), ...revisions, "--"])
  ]);
  const targets: Targets = new Map();
  for (const file of log.stdout.split("\0")) if (file) targets.set(file, { mayReplaceDirectory: true });
  const original = parents.stdout.split(/[\0\r\n ]/, 1)[0];
  if (original && targets.size) await addRelocatedReplayPaths(repo, targets, original, destination);
  const labels = new Set<string>();
  const fields = parents.stdout.split("\0");
  for (let i = 0; i + 2 < fields.length; i += 3) {
    const abbreviation = fields[i + 1];
    // Both backends use the first subject line, not the folded %s paragraph.
    const name = (fields[i + 2].match(/[^\r\n]+/)?.[0] ?? "").replaceAll("/", "_");
    labels.add(name); // The apply backend uses the patch subject without parentheses.
    labels.add(name.trimEnd()); // Also check the bare filename with terminal whitespace removed.
    // The merge backend preserves trailing spaces inside the parentheses.
    labels.add(`${abbreviation} (${name})`);
  }
  if (targets.size) await addReplayConflictPaths(repo, targets, destination, labels);
  await checkLocalPaths(repo, targets, true);
}

export async function assertNoReplayCollision(repo: string, commits: string[], trees: string[] = []): Promise<void> {
  if ([...commits, ...trees].some(oid => !/^[a-f0-9]{4,64}$/.test(oid))) throw new Error("Git could not identify a pending rebase commit.");
  if ((!commits.length && !trees.length) || !await hasUntrackedData(repo)) return;
  for (const batch of argumentBatches(new Set(commits))) await checkReplayPaths(repo, ["--no-walk=unsorted", ...batch]);
  for (const tree of trees) await checkTreePaths(repo, tree, true);
}

export async function assertNoIgnoredCheckoutCollision(repo: string, remoteTip: string, replayRange?: string, integrationArgs?: readonly string[]): Promise<void> {
  const merging = integrationArgs?.[0] === "merge";
  if ((merging || replayRange) && !await hasUntrackedData(repo)) return;
  let checkoutTree = remoteTip;
  if (merging) {
    const { strategies, options, branchFf } = await mergeStrategies(repo);
    if (strategies.length === 1 && strategies[0] === "ours") return;
    if (options.length || strategies.some(name => name !== "ort")) {
      // Git applies branch merge options before the pull plan's explicit fast-forward policy.
      const ff = [...branchFf, ...integrationArgs.filter(arg => ffOptions.includes(arg))];
      return checkStrategyMerge(repo, remoteTip, strategies, options, ff);
    }
    // With the default strategy and no strategy options, merging a descendant
    // produces its tree even when Git records a merge commit for --no-ff.
    const ancestor = await tryGit(repo, ["merge-base", "--is-ancestor", "HEAD", remoteTip]);
    if (ancestor.code === 0) return checkTreePaths(repo, remoteTip, false);
    if (ancestor.code !== 1) throw new Error(ancestor.stderr.trim() || "Could not compare the commits before syncing.");
    // The merged tree respects local deletions and includes destinations Git
    // relocates into renamed directories, even when the merge pauses for review.
    const merge = await previewMergeTree(repo, remoteTip);
    checkoutTree = merge.stdout.split("\0", 1)[0];
    if ((merge.code !== 0 && merge.code !== 1) || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(checkoutTree)) {
      throw new Error(merge.stderr.trim() || "Git could not preview the merge to check for local file collisions.");
    }
  }
  // A rebase or first checkout initially writes the incoming tree itself.
  await checkTreePaths(repo, checkoutTree, false);
  if (replayRange) await checkReplayPaths(repo, [replayRange], remoteTip);
}

async function checkTreePaths(repo: string, checkoutTree: string, includeUntracked: boolean) {
  const diff = await runGit(repo, ["diff", "--cached", "-R", "--raw", "-z", "--no-renames", "--diff-filter=AMT", checkoutTree, "--"]);
  await checkLocalPaths(repo, targetsFromDiff(diff.stdout), includeUntracked);
}

function targetsFromDiff(output: string) {
  const fields = output.split("\0");
  const targets: Targets = new Map();
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const [indexMode, targetMode] = fields[i].slice(1).split(" ");
    targets.set(fields[i + 1], { mayReplaceDirectory: !(indexMode === "160000" && targetMode === "160000") });
  }
  return targets;
}
