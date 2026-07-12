import registerWolframSessions from "./wolfram.ts";

export default function wolframSessionsExtension(pi: any): void {
	registerWolframSessions(pi);
}
