import registerProfiler from "./profiler.ts";
import registerTuiHotfix from "./tui-hotfix.ts";

export default function helpersExtension(pi: any): void {
	// Install instrumentation first so it can see registrations made below.
	registerProfiler(pi);
	registerTuiHotfix();
}
