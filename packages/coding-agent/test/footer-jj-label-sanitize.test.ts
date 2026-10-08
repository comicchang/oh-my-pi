/**
 * The footer renders the jj label verbatim inside the working-directory
 * segment, so repository-controlled control characters must be sanitized
 * at the cache boundary, mirroring the status-line jj label path.
 */
import * as nodeFs from "node:fs";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { FooterComponent } from "@oh-my-pi/pi-tui/status-line/footer";
import { statusLineHost } from "@oh-my-pi/pi-coding-agent/modes/status-line-host";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import type { VcsRepo } from "@oh-my-pi/pi-natives";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { getProjectDir, setProjectDir } from "@oh-my-pi/pi-utils";

const itOnLinux = process.platform === "linux" ? it : it.skip;
const originalProjectDir = getProjectDir();

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	await initTheme();
});

afterAll(() => {
	resetSettingsForTest();
	setProjectDir(originalProjectDir);
});

afterEach(() => {
	vi.restoreAllMocks();
});

function makeSession() {
	return {
		state: { messages: [], model: undefined },
		messages: [],
		model: undefined,
		systemPrompt: [],
		agent: { state: { tools: [] } },
		skills: [],
		isStreaming: false,
		isAutoThinking: false,
		autoResolvedThinkingLevel: () => undefined,
		isFastModeActive: () => false,
		isFastModeEnabled: () => false,
		getGoalModeState: () => null,
		getContextUsage: () => undefined,
		getAsyncJobSnapshot: () => ({ running: [] }),
		modelRegistry: { isUsingOAuth: () => false },
		sessionManager: {
			getSessionName: () => "footer-sanitize test",
			getEntries: () => [],
			getUsageStatistics: () => ({
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				premiumRequests: 0,
				cost: 0,
			}),
		},
	} as unknown as ConstructorParameters<typeof FooterComponent>[0];
}

async function flush(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
}

describe("FooterComponent VCS behavior", () => {
	it("sanitizes control characters from the jj label", async () => {
		const root = "/repo/footer-sanitize";
		const jj = {
			kind: () => "jj",
			asGit: () => null,
			asJj: () => ({}) as never,
			root: () => root,
			watchTarget: () => `${root}/.jj/repo/op_heads/heads`,
			label: async () => `footer-${String.fromCharCode(7)}bookmark`,
		} as unknown as VcsRepo;
		vi.spyOn(vcs, "repoForDisplay").mockReturnValue(jj);
		vi.spyOn(vcs, "watch").mockImplementation((() => () => {}) as unknown as typeof vcs.watch);

		const component = new FooterComponent(makeSession(), statusLineHost);
		component.watchBranch(() => {});
		try {
			component.render(80);
			await flush();
			const content = component.render(80).join("\n");
			expect(content).toContain("(footer-");
			expect(content).toContain("bookmark)");
			expect(content).not.toContain(String.fromCharCode(7));
		} finally {
			component.dispose();
		}
	});
	itOnLinux("does not probe VCS when the footer cwd is on FUSE", () => {
		const previousProjectDir = getProjectDir();
		const fuseDir = previousProjectDir;
		const mountInfo = [
			"29 24 0:1 / / rw,relatime - ext4 /dev/root rw",
			`45 29 0:51 / ${fuseDir} rw,nosuid,nodev,relatime - fuse.borgfs borgfs rw,user_id=1000`,
		].join("\n");
		vi.spyOn(statusLineHost, "gitEnabled").mockReturnValue(true);
		vi.spyOn(nodeFs, "readFileSync").mockReturnValue(mountInfo as never);
		const repoForDisplaySpy = vi.spyOn(vcs, "repoForDisplay").mockReturnValue(null);
		const watchSpy = vi.spyOn(vcs, "watch").mockImplementation((() => () => {}) as unknown as typeof vcs.watch);
		setProjectDir(fuseDir);
		const component = new FooterComponent(makeSession(), statusLineHost);
		try {
			component.watchBranch(vi.fn());
			component.render(80);
			component.render(80);

			expect(repoForDisplaySpy).not.toHaveBeenCalled();
			expect(watchSpy).not.toHaveBeenCalled();
		} finally {
			component.dispose();
			setProjectDir(previousProjectDir);
		}
	});
});
