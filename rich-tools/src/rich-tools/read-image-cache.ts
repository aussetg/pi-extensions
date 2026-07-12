import type { Image } from "@earendil-works/pi-tui";

export type InlineReadImage = { data: string; mimeType: string };
export type InlineReadImageComponent = InlineReadImage & { component: Image };

export function reconcileInlineImageComponents(
  previous: InlineReadImageComponent[],
  images: InlineReadImage[],
  create: (image: InlineReadImage) => InlineReadImageComponent,
): InlineReadImageComponent[] {
  return images.map((image, index) => {
    const current = previous[index];
    return current && sameInlineImage(current, image) ? current : create(image);
  });
}

function sameInlineImage(left: InlineReadImage, right: InlineReadImage): boolean {
  return left.mimeType === right.mimeType && left.data === right.data;
}
