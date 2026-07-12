declare module "bun:jsc" {
	export function profile(
		callback: () => Promise<void>,
		intervalUs: number,
	): Promise<unknown>;
}
