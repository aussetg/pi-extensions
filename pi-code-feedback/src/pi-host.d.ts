declare module "@earendil-works/pi-coding-agent" {
  export function withFileMutationQueue<T>(filePath: string, run: () => Promise<T>): Promise<T>;
}
