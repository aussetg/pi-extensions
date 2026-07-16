declare module "@earendil-works/pi-coding-agent" {
  export const CONFIG_DIR_NAME: string;
  export function getAgentDir(): string;
  export function withFileMutationQueue<T>(filePath: string, run: () => Promise<T>): Promise<T>;
}
