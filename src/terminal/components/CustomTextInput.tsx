/** Custom text input — pure display, NO useInput hook. */

import React from "react";
import { Text } from "ink";
import { COLORS } from "../colors.js";

interface CustomTextInputProps {
  value: string;
  placeholder?: string;
}

export function CustomTextInput({ value, placeholder }: CustomTextInputProps): React.ReactElement {
  return (
    <Text>
       {" "}{markImagePaths(value)}
      <Text color={COLORS.azure}>{"▏"}</Text>
      {!value && placeholder ? (
        <Text color={COLORS.dim}> {placeholder}</Text>
      ) : null}
    </Text>
  );
}

function markImagePaths(text: string): string {
  return text.replace(
    /("[^"\r\n]+\.(?:png|jpe?g|gif|webp|bmp|tiff?)"|'[^'\r\n]+\.(?:png|jpe?g|gif|webp|bmp|tiff?)'|(?:[A-Za-z]:[\\/]|\/)[^\s"']+\.(?:png|jpe?g|gif|webp|bmp|tiff?))/gi,
    "[image]",
  );
}
