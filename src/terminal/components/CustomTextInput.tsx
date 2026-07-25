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
      {" "}{value}
      <Text color={COLORS.azure}>{"▏"}</Text>
      {!value && placeholder ? (
        <Text color={COLORS.dim}> {placeholder}</Text>
      ) : null}
    </Text>
  );
}
