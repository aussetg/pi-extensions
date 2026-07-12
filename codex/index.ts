import registerAutoswitch from "./autoswitch.ts";
import registerQuota from "./quota.ts";

export default function codexExtension(pi: any): void {
	registerAutoswitch(pi);
	registerQuota(pi);
}
