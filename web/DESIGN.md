---
name: MultiReviewer
description: Internal review-ops panel. Category-standard admin at GitHub / Linear / Vercel craft.
colors:
  primary: "#1f2328"
  primary-foreground: "#ffffff"
  background: "#ffffff"
  chrome: "#f6f8fa"
  muted: "#f6f8fa"
  muted-foreground: "#59636e"
  border: "#d0d7de"
  destructive: "#cf222e"
  success: "#1a7f37"
  warning: "#9a6700"
typography:
  body:
    fontFamily: "ui-sans-serif, -apple-system, Segoe UI, PingFang SC, Microsoft YaHei, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.55
  title:
    fontFamily: "ui-sans-serif, -apple-system, Segoe UI, PingFang SC, Microsoft YaHei, system-ui, sans-serif"
    fontSize: "19px"
    fontWeight: 600
    lineHeight: 1.25
  label:
    fontFamily: "ui-sans-serif, -apple-system, Segoe UI, PingFang SC, Microsoft YaHei, system-ui, sans-serif"
    fontSize: "11px"
    fontWeight: 500
    lineHeight: 1.45
rounded:
  sm: "6px"
  md: "6px"
spacing:
  sm: "8px"
  md: "16px"
  lg: "20px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.primary-foreground}"
    rounded: "{rounded.sm}"
    height: "32px"
  chip-selected:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.primary-foreground}"
    rounded: "999px"
    padding: "4px 10px"
---

# Design System: MultiReviewer

## Overview

**Creative North Star: "The Checks List"**

The panel is a familiar product admin. It sits next to GitHub, Linear and Vercel on craft, not on costume. Surfaces are white, the shell is cool gray, the primary action is near-black. Status is the only color that speaks.

Density is for someone who opens this several times a day. The first screen after login is 评审记录, read as a checks list: a status glyph, a thin-ruled table, filter chips.

**Key Characteristics:**

- Light only
- Near-black primary, never teal, never brand-blue, never Linear purple
- Status colors are laws: red fail, green ok, amber attention
- Hairlines and tonal layers, not shadows
- System sans, six-step type scale

## Colors

Restrained: neutrals plus semantic status. Primary is ink, not decoration.

### Primary
- **Ink** (`#1f2328`): primary buttons, selected chips, current emphasis.

### Neutral
- **Paper** (`#ffffff`): content and cards
- **Shell** (`#f6f8fa`): sidebar
- **Secondary ink** (`#59636e`): meta text, must clear 4.5:1 on shell and paper
- **Rule** (`#d0d7de`): borders and table lines

### Named Rules
**The Reserved Flash Rule.** Red, green and amber only mark fail / ok / attention. They are not brand.

**The No Teal Rule.** `#0e7490` and its family are retired. Do not bring them back.

## Typography

**Body Font:** system sans (`ui-sans-serif`, PingFang SC / Microsoft YaHei for Chinese)
**Label/Mono Font:** system mono, numbers only, never around Chinese

### Hierarchy
- **Title** (600, 19px): one page title
- **Body** (400, 13px): controls and content
- **Label** (500, 11px): meta, table heads, chips

**The Six Steps Rule.** Only the token scale. No one-off `text-[13px]`.

## Layout

Left rail 200px, content white. Sticky page header. Review runs table maxes around 1100px and stays left, it does not stretch with an ultrawide window. Narrow viewports stack the rail on top and scroll sideways.

## Elevation & Depth

Flat. Depth is a cooler shell behind a white content plane, plus 1px rules. Current nav is a white inset with a hairline, not a colored bar.

## Shapes

6px corners on controls, cards and the current nav item. Filter chips are pills. Tables live inside a 1px rounded box.

## Components

### Buttons
- **Primary:** ink fill, white type, 6px
- **Outline:** paper fill, rule border
- **Hover:** slightly stronger fill or muted wash
- **Focus:** ink ring

### Chips
- Unselected: muted fill, secondary ink
- Selected: ink fill, white type

### Cards / Containers
- Paper, 1px rule, 6px, no shadow

### Navigation
- Shell background. Current item is a white rounded row with a hairline. `aria-current="page"` is required.

### Checks table
- Status glyph in the first column. Failed rows take a 10% destructive wash. Filter chips sit above the table and only filter already-loaded rows.

## Do's and Don'ts

### Do:
- **Do** land login on 评审记录.
- **Do** keep status color contrast ≥ 4.5:1 on paper, muted and shell.
- **Do** put irreversible actions behind a confirm that can be previewed.

### Don't:
- **Don't** use teal, cyan, indigo or Linear purple as primary.
- **Don't** wrap the first viewport in a row of metric cards.
- **Don't** invent a new interaction grammar. This is a standard admin.
