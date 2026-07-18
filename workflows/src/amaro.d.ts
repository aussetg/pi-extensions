declare module "amaro" {
  export interface AmaroTransformOptions {
    mode: "strip-only";
  }

  export interface AmaroTransformResult {
    code: string;
  }

  export function transformSync(
    source: string,
    options: AmaroTransformOptions,
  ): AmaroTransformResult;
}
