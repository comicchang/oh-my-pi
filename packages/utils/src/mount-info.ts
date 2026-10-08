import * as fs from "node:fs";
import * as path from "node:path";

export const LINUX_MOUNT_INFO_PATH = "/proc/self/mountinfo";

export interface MountInfoEntry {
	mountPoint: string;
	fileSystemType: string;
}

/** Decodes Linux mountinfo octal escapes (for example, `\\040` for a space). */
export function decodeMountPointEscape(rawMountPoint: string): string {
	return rawMountPoint.replace(/\\([0-7]{3})/g, (_escape, octal: string) =>
		String.fromCharCode(Number.parseInt(octal, 8)),
	);
}

/** Parses the mount point and filesystem type from Linux `/proc/self/mountinfo`. */
export function parseMountInfo(mountInfo: string): MountInfoEntry[] | null {
	const entries: MountInfoEntry[] = [];
	for (const line of mountInfo.split("\n")) {
		if (!line.trim()) continue;
		const separator = line.indexOf(" - ");
		if (separator < 0) return null;

		const mountFields = line.slice(0, separator).trim().split(/\s+/);
		const filesystemFields = line
			.slice(separator + 3)
			.trim()
			.split(/\s+/);
		const mountPointField = mountFields[4];
		const fileSystemType = filesystemFields[0];
		if (mountFields.length < 6 || filesystemFields.length < 3 || !mountPointField || !fileSystemType) {
			return null;
		}

		const mountPoint = decodeMountPointEscape(mountPointField);
		if (!mountPoint.startsWith("/")) return null;
		entries.push({ mountPoint: path.posix.normalize(mountPoint), fileSystemType });
	}

	return entries.length > 0 ? entries : null;
}

/** Matches FUSE filesystems, including named subtypes such as `fuse.borgfs`. */
export function isFuseFileSystemType(fileSystemType: string): boolean {
	return fileSystemType === "fuse" || fileSystemType === "fuseblk" || fileSystemType.startsWith("fuse.");
}

/** Pure path lookup using mountinfo text; ambiguous or incomplete data fails closed. */
export function isFuseMountPath(targetPath: string, mountInfo: string): boolean {
	const entries = parseMountInfo(mountInfo);
	if (!entries) return true;

	const normalizedTarget = path.posix.normalize(targetPath);
	if (!normalizedTarget.startsWith("/")) return true;

	let longestMountPoint: string | null = null;
	const fileSystemTypes = new Set<string>();
	for (const entry of entries) {
		const matchesMountPoint =
			entry.mountPoint === "/" ||
			normalizedTarget === entry.mountPoint ||
			normalizedTarget.startsWith(`${entry.mountPoint}/`);
		if (!matchesMountPoint) continue;

		if (entry.mountPoint.length > (longestMountPoint?.length ?? -1)) {
			longestMountPoint = entry.mountPoint;
			fileSystemTypes.clear();
		}
		if (entry.mountPoint.length === longestMountPoint?.length) {
			fileSystemTypes.add(entry.fileSystemType);
		}
	}

	if (longestMountPoint === null || fileSystemTypes.size !== 1) return true;
	const fileSystemType = fileSystemTypes.values().next().value;
	return fileSystemType === undefined || isFuseFileSystemType(fileSystemType);
}

/** Reads `/proc/self/mountinfo` asynchronously; non-Linux hosts do not need this policy. */
export async function isFusePath(targetPath: string): Promise<boolean> {
	if (process.platform !== "linux") return false;
	try {
		return isFuseMountPath(targetPath, await Bun.file(LINUX_MOUNT_INFO_PATH).text());
	} catch {
		return true;
	}
}

/** Synchronous counterpart for call sites whose VCS probe is synchronous. */
export function isFusePathSync(targetPath: string): boolean {
	if (process.platform !== "linux") return false;
	try {
		return isFuseMountPath(targetPath, fs.readFileSync(LINUX_MOUNT_INFO_PATH, "utf8"));
	} catch {
		return true;
	}
}
