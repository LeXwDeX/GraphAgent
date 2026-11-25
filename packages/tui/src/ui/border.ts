export const EmptyBorder = {
  topLeft: "",
  bottomLeft: "",
  vertical: "",
  topRight: "",
  bottomRight: "",
  horizontal: " ",
  bottomT: "",
  topT: "",
  cross: "",
  leftT: "",
  rightT: "",
}

export const SplitBorder = {
  border: ["left" as const, "right" as const],
  customBorderChars: {
    ...EmptyBorder,
    vertical: "┃",
  },
}

/**
 * A frame with dashed edges: the read-only notice a sub-agent view shows where the input would be. The renderer has
 * no dashed border style, so the dashes are the horizontal and vertical characters and the corners stay solid.
 */
export const DashedBorder = {
  border: ["top" as const, "right" as const, "bottom" as const, "left" as const],
  customBorderChars: {
    topLeft: "┌",
    topRight: "┐",
    bottomLeft: "└",
    bottomRight: "┘",
    horizontal: "╌",
    vertical: "╎",
    topT: "┬",
    bottomT: "┴",
    leftT: "├",
    rightT: "┤",
    cross: "┼",
  },
}
