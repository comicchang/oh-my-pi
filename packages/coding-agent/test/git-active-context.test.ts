import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";

import {
	resolveActiveRepoContext,
	resolveActiveRepoContextSync,
} from "@oh-my-pi/pi-coding-agent/utils/active-repo-context";
import type { ActiveRepoContext } from "@oh-my-pi/pi-tui/status-line/host";
import * as vcs from "@oh-my-pi/pi-natives/vcs";

const itOnLinux = process.platform === "linux" ? it : it.skip;
const itWithSymlinkPrivilege = process.platform === "win32" ? it.skip : it;

function createGitDirectory(repoRoot: string): void {
	const gitDir = path.join(repoRoot, ".git");
	fs.mkdirSync(gitDir, { recursive: true });
	fs.writeFileSync(path.join(gitDir, "HEAD"), "ref: refs/heads/main\n", "utf8");
}

function createLinkedWorktreeGitFile(worktreeRoot: string, gitDir: string, commonDir: string): void {
	fs.mkdirSync(worktreeRoot, { recursive: true });
	fs.mkdirSync(gitDir, { recursive: true });
	fs.mkdirSync(commonDir, { recursive: true });
	fs.writeFileSync(path.join(gitDir, "HEAD"), "ref: refs/heads/main\n", "utf8");
	fs.writeFileSync(path.join(gitDir, "commondir"), `${path.relative(gitDir, commonDir)}\n`, "utf8");
	fs.writeFileSync(path.join(commonDir, "HEAD"), "ref: refs/heads/main\n", "utf8");
	fs.writeFileSync(path.join(worktreeRoot, ".git"), `gitdir: ${path.relative(worktreeRoot, gitDir)}\n`, "utf8");
}

async function expectResolvers(cwd: string, expected: ActiveRepoContext | null): Promise<void> {
	expect(resolveActiveRepoContextSync(cwd)).toEqual(expected);
	expect(await resolveActiveRepoContext(cwd)).toEqual(expected);
}

describe("resolveActiveRepoContext", () => {
	let tempRoot: string;

	beforeEach(() => {
		tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omp-active-repo-context-"));
	});

	afterEach(() => {
		vi.restoreAllMocks();
		fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	});

	it("returns null when cwd is already inside a repository", async () => {
		const repoRoot = path.join(tempRoot, "repo");
		const cwd = path.join(repoRoot, "nested");
		fs.mkdirSync(cwd, { recursive: true });
		createGitDirectory(repoRoot);

		await expectResolvers(cwd, null);
	});

	it("returns null when no direct child repository exists", async () => {
		const cwd = path.join(tempRoot, "workspace");
		fs.mkdirSync(path.join(cwd, "not-a-repo"), { recursive: true });
		fs.writeFileSync(path.join(cwd, "plain-file.txt"), "ignored\n", "utf8");

		await expectResolvers(cwd, null);
	});

	it("ignores a leftover child .git directory without HEAD", async () => {
		const cwd = path.join(tempRoot, "workspace");
		fs.mkdirSync(path.join(cwd, "leftover", ".git", "objects"), { recursive: true });

		await expectResolvers(cwd, null);
	});

	it("does not accept a directory named HEAD as repository metadata", async () => {
		const cwd = path.join(tempRoot, "workspace");
		fs.mkdirSync(path.join(cwd, "leftover", ".git", "HEAD"), { recursive: true });

		await expectResolvers(cwd, null);
	});

	it("ignores malformed child .git files", async () => {
		const cwd = path.join(tempRoot, "workspace");
		const repoRoot = path.join(cwd, "leftover");
		fs.mkdirSync(repoRoot, { recursive: true });
		fs.writeFileSync(path.join(repoRoot, ".git"), "not a gitdir pointer\n", "utf8");

		await expectResolvers(cwd, null);
	});

	it("ignores a child gitfile whose target has been removed", async () => {
		const cwd = path.join(tempRoot, "workspace");
		const repoRoot = path.join(cwd, "leftover");
		fs.mkdirSync(repoRoot, { recursive: true });
		fs.writeFileSync(path.join(repoRoot, ".git"), "gitdir: ../../removed-admin\n", "utf8");

		await expectResolvers(cwd, null);
	});

	it("ignores a child gitfile whose target has no HEAD", async () => {
		const cwd = path.join(tempRoot, "workspace");
		const repoRoot = path.join(cwd, "leftover");
		const gitDir = path.join(tempRoot, "admin");
		fs.mkdirSync(repoRoot, { recursive: true });
		fs.mkdirSync(gitDir, { recursive: true });
		fs.writeFileSync(path.join(repoRoot, ".git"), `gitdir: ${path.relative(repoRoot, gitDir)}\n`, "utf8");

		await expectResolvers(cwd, null);
	});

	it("selects a valid child when a leftover sibling also has a .git marker", async () => {
		const cwd = path.join(tempRoot, "workspace");
		const repoRoot = path.join(cwd, "repo");
		fs.mkdirSync(path.join(cwd, "leftover", ".git"), { recursive: true });
		createGitDirectory(repoRoot);

		await expectResolvers(cwd, {
			cwd,
			repoRoot,
			relativeRepoRoot: "repo",
			source: "single-direct-child-repo",
		});
	});

	it("returns the sole direct child repository context", async () => {
		const cwd = path.join(tempRoot, "workspace");
		const repoRoot = path.join(cwd, "repo");
		fs.mkdirSync(path.join(cwd, "not-a-repo"), { recursive: true });
		fs.writeFileSync(path.join(cwd, "plain-file.txt"), "ignored\n", "utf8");
		createGitDirectory(repoRoot);

		const expected = {
			cwd,
			repoRoot,
			relativeRepoRoot: "repo",
			source: "single-direct-child-repo",
		} satisfies ActiveRepoContext;
		await expectResolvers(cwd, expected);
	});

	itWithSymlinkPrivilege("treats a direct child symlink to a repository directory as that child", async () => {
		const cwd = path.join(tempRoot, "workspace");
		const targetRoot = path.join(tempRoot, "target-repo");
		const repoRoot = path.join(cwd, "linked-repo");
		fs.mkdirSync(cwd, { recursive: true });
		createGitDirectory(targetRoot);
		fs.symlinkSync(targetRoot, repoRoot, "junction");

		const expected = {
			cwd,
			repoRoot,
			relativeRepoRoot: "linked-repo",
			source: "single-direct-child-repo",
		} satisfies ActiveRepoContext;
		await expectResolvers(cwd, expected);
	});

	it("returns null when two direct child repositories exist", async () => {
		const cwd = path.join(tempRoot, "workspace");
		fs.mkdirSync(cwd, { recursive: true });
		createGitDirectory(path.join(cwd, "alpha"));
		createGitDirectory(path.join(cwd, "beta"));

		await expectResolvers(cwd, null);
	});

	it("accepts a direct child linked-worktree .git file", async () => {
		const cwd = path.join(tempRoot, "workspace");
		const repoRoot = path.join(cwd, "worktree");
		const gitDir = path.join(tempRoot, "admin", "worktrees", "worktree");
		const commonDir = path.join(tempRoot, "admin", "common.git");
		fs.mkdirSync(cwd, { recursive: true });
		createLinkedWorktreeGitFile(repoRoot, gitDir, commonDir);

		const expected = {
			cwd,
			repoRoot,
			relativeRepoRoot: "worktree",
			source: "single-direct-child-repo",
		} satisfies ActiveRepoContext;
		await expectResolvers(cwd, expected);
	});
	itOnLinux("skips native VCS and directory probes when cwd is on a FUSE mount", async () => {
		const cwd = "/mnt/omp-fuse cwd/project";
		const mountInfo = [
			"29 24 0:1 / / rw,relatime - ext4 /dev/root rw",
			"45 29 0:51 / /mnt/omp-fuse\\040cwd rw,nosuid,nodev,relatime - fuse.borgfs borgfs rw,user_id=1000",
		].join("\n");
		const bunFileSpy = vi.spyOn(Bun, "file").mockReturnValue({
			text: async () => mountInfo,
		} as never);
		const mountInfoReadSyncSpy = vi.spyOn(fs, "readFileSync").mockReturnValue(mountInfo as never);
		const repoSpy = vi.spyOn(vcs, "repo").mockReturnValue(null);
		const gitInfoSpy = vi.spyOn(vcs, "gitInfo");
		const readdirSpy = vi.spyOn(fsPromises, "readdir");
		const statSpy = vi.spyOn(fsPromises, "stat");
		const readdirSyncSpy = vi.spyOn(fs, "readdirSync");
		const statSyncSpy = vi.spyOn(fs, "statSync");

		await expect(resolveActiveRepoContext(cwd)).resolves.toBeNull();
		expect(bunFileSpy).toHaveBeenCalledWith("/proc/self/mountinfo");
		expect(repoSpy).not.toHaveBeenCalled();
		expect(gitInfoSpy).not.toHaveBeenCalled();
		expect(readdirSpy).not.toHaveBeenCalled();
		expect(statSpy).not.toHaveBeenCalled();

		expect(resolveActiveRepoContextSync(cwd)).toBeNull();
		expect(mountInfoReadSyncSpy).toHaveBeenCalledWith("/proc/self/mountinfo", "utf8");
		expect(repoSpy).not.toHaveBeenCalled();
		expect(gitInfoSpy).not.toHaveBeenCalled();
		expect(readdirSyncSpy).not.toHaveBeenCalled();
		expect(statSyncSpy).not.toHaveBeenCalled();
	});
});
