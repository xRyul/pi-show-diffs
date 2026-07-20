export type PathStyle = "full" | "short";

export function formatDisplayPath(path: string, style: PathStyle, segments: number): string {
	if (style !== "short" || segments <= 0) return path;

	const parts = path.split(/[/\\]/);
	if (parts.length <= segments) return path;

	return `…/${parts.slice(-segments).join("/")}`;
}
