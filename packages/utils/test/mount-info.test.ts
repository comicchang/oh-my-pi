import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import {
	decodeMountPointEscape,
	isFuseFileSystemType,
	isFuseMountPath,
	isFusePath,
	isFusePathSync,
	LINUX_MOUNT_INFO_PATH,
	parseMountInfo,
} from "../src/mount-info";

const originalPlatform = process.platform;
const sampleMountInfo = [
	"29 24 0:1 / / rw,relatime - ext4 /dev/root rw",
	"45 29 0:51 / /mnt/fuse rw,nosuid,nodev,relatime - fuse.borgfs borgfs rw,user_id=1000",
	"46 45 0:52 / /mnt/fuse/local rw,relatime - ext4 /dev/loop0 rw",
	"47 29 0:53 / /mnt/disk rw,relatime - fuseblk /dev/loop1 rw",
	"48 29 0:54 / /mnt/network\\040share rw,relatime - fuse.sshfs user@host:/ rw",
].join("\n");

afterEach(() => {
	vi.restoreAllMocks();
	Object.defineProperty(process, "platform", { value: originalPlatform });
});

function setPlatform(platform: string): void {
	Object.defineProperty(process, "platform", { value: platform });
}

describe("mountinfo parsing", () => {
	it("decodes Linux octal escapes in mount points", () => {
		expect(decodeMountPointEscape("/mnt/network\\040share\\134archive")).toBe("/mnt/network share\\archive");
	});

	it("extracts mount points and filesystem types from valid entries", () => {
		expect(parseMountInfo(sampleMountInfo)?.slice(0, 2)).toEqual([
			{ mountPoint: "/", fileSystemType: "ext4" },
			{ mountPoint: "/mnt/fuse", fileSystemType: "fuse.borgfs" },
		]);
	});

	it("rejects malformed entries instead of treating them as local mounts", () => {
		expect(parseMountInfo("not mountinfo")).toBeNull();
		expect(parseMountInfo("1 2 0:1 / relative rw - ext4 /dev/root rw")).toBeNull();
		expect(parseMountInfo("")).toBeNull();
	});
});

describe("FUSE mount selection", () => {
	it("recognizes FUSE mounts and descendants, including escaped mount points", () => {
		expect(isFuseMountPath("/mnt/fuse", sampleMountInfo)).toBe(true);
		expect(isFuseMountPath("/mnt/fuse/repo", sampleMountInfo)).toBe(true);
		expect(isFuseMountPath("/mnt/network share/repo", sampleMountInfo)).toBe(true);
		expect(isFuseMountPath("/mnt/disk/file", sampleMountInfo)).toBe(true);
	});

	it("uses the most specific mount and respects path-component boundaries", () => {
		expect(isFuseMountPath("/mnt/fuse/local/repo", sampleMountInfo)).toBe(false);
		expect(isFuseMountPath("/mnt/fuse-other/repo", sampleMountInfo)).toBe(false);
		expect(isFuseMountPath("/home/project", sampleMountInfo)).toBe(false);
	});

	it("matches only the documented FUSE filesystem type names", () => {
		expect(isFuseFileSystemType("fuse")).toBe(true);
		expect(isFuseFileSystemType("fuseblk")).toBe(true);
		expect(isFuseFileSystemType("fuse.borgfs")).toBe(true);
		expect(isFuseFileSystemType("ext4")).toBe(false);
	});

	it("fails closed for unknown or ambiguous mount data", () => {
		const conflicting = [
			"29 24 0:1 / / rw - ext4 /dev/root rw",
			"45 29 0:51 / /mnt/fuse rw - fuse.borgfs borgfs rw",
			"46 29 0:52 / /mnt/fuse rw - ext4 /dev/loop0 rw",
		].join("\n");
		expect(isFuseMountPath("/mnt/fuse/repo", conflicting)).toBe(true);
		expect(isFuseMountPath("/home/project", "malformed")).toBe(true);
		expect(isFuseMountPath("relative/path", sampleMountInfo)).toBe(true);
		expect(isFuseMountPath("/unmatched", "45 29 0:51 / /mnt rw - ext4 /dev/root rw")).toBe(true);
	});
});

describe("isFusePath wrappers", () => {
	it("returns false without I/O on non-Linux hosts", async () => {
		setPlatform("darwin");
		const readFileSyncSpy = vi.spyOn(fs, "readFileSync");
		const bunFileSpy = vi.spyOn(Bun, "file");

		expect(await isFusePath("/some/path")).toBe(false);
		expect(isFusePathSync("/some/path")).toBe(false);
		expect(readFileSyncSpy).not.toHaveBeenCalled();
		expect(bunFileSpy).not.toHaveBeenCalled();
	});

	it("reads mountinfo for both asynchronous and synchronous Linux callers", async () => {
		setPlatform("linux");
		const bunFileSpy = vi.spyOn(Bun, "file").mockReturnValue({
			text: async () => sampleMountInfo,
		} as unknown as Bun.BunFile);
		const readFileSyncSpy = vi.spyOn(fs, "readFileSync").mockReturnValue(sampleMountInfo as never);

		expect(await isFusePath("/mnt/fuse/repo")).toBe(true);
		expect(isFusePathSync("/mnt/fuse/repo")).toBe(true);
		expect(bunFileSpy).toHaveBeenCalledWith(LINUX_MOUNT_INFO_PATH);
		expect(readFileSyncSpy).toHaveBeenCalledWith(LINUX_MOUNT_INFO_PATH, "utf8");
	});

	it("fails closed when Linux mountinfo cannot be read", async () => {
		setPlatform("linux");
		vi.spyOn(Bun, "file").mockReturnValue({
			text: () => Promise.reject(new Error("EACCES")),
		} as unknown as Bun.BunFile);
		vi.spyOn(fs, "readFileSync").mockImplementation(() => {
			throw new Error("EACCES");
		});

		expect(await isFusePath("/home/project")).toBe(true);
		expect(isFusePathSync("/home/project")).toBe(true);
	});
});
