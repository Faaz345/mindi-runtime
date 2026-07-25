/**
 * Type augmentation for Ink's Text component.
 * Ink supports `dim` at runtime but doesn't include it in TypeScript types.
 */

import "ink";

declare module "ink" {
  interface TextProps {
    dim?: boolean;
  }
}
