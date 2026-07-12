import registerWolframSessions from "./wolfram.ts";

export default function notebooksExtension(pi: any): void {
	registerWolframSessions(pi);
}
