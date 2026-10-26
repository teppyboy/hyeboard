---
name: Hyeboard
description: A unified academic dashboard for students across supported universities.
colors:
  neutral-background: "#ffffff"
  neutral-foreground: "#0a0a0a"
  neutral-muted: "#f5f5f5"
  neutral-muted-foreground: "#6b6b6b"
  neutral-border: "#e6e6e6"
  neutral-accent: "#f0f0f0"
  uet-primary: "#003a70"
  vnu-primary: "#7b1e2b"
  success: "#1d873d"
  warning: "#c2740a"
typography:
  body:
    fontFamily: "Geist, ui-sans-serif, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.5
  title:
    fontFamily: "Geist, ui-sans-serif, system-ui, sans-serif"
    fontSize: "24px"
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: "-0.025em"
  label:
    fontFamily: "Geist, ui-sans-serif, system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: 600
    lineHeight: 1.4
rounded:
  sm: "6px"
  md: "8px"
  lg: "12px"
spacing:
  sm: "8px"
  md: "16px"
  lg: "24px"
components:
  button-primary:
    backgroundColor: "{colors.neutral-foreground}"
    textColor: "{colors.neutral-background}"
    rounded: "{rounded.sm}"
    padding: "8px 16px"
  button-outline:
    backgroundColor: "{colors.neutral-background}"
    textColor: "{colors.neutral-foreground}"
    rounded: "{rounded.sm}"
    padding: "8px 16px"
  bordered-section:
    backgroundColor: "{colors.neutral-background}"
    textColor: "{colors.neutral-foreground}"
    rounded: "{rounded.md}"
    padding: "16px"
---

# Design System: Hyeboard

## Overview

**Creative North Star: "The Quiet Command Center"**

Hyeboard’s incumbent interface is a calm, precise workspace for academic operations. Its warmth comes from approachable copy, generous touch targets, soft neutral surfaces, and university-aware accents—not from decorative effects. The system is intentionally readable at a glance: a student or operator should know where they are, what is available, what changed, and what action is safe to take.

The visual language is restrained but not sterile. Thin borders, tonal surfaces, and compact rows create structure without turning every section into a floating card. The admin dashboard uses the same foundation as the student product while giving policy controls and audit history enough emphasis to support careful operational work.

**Key Characteristics:**
- Quiet neutral foundation with theme-aware UET and VNU accents.
- Warm, direct copy carried by a compact operational layout.
- Flat bordered sections, divided rows, and minimal decorative chrome.
- Explicit loading, error, empty, disabled, and conflict states.

## Colors

The base palette is near-monochrome so information hierarchy and university identity can carry the interface. UET blue and VNU burgundy are theme accents; success and warning colors communicate state rather than decoration.

### Primary
- **Neutral Ink** (#0a0a0a): Default action, primary text, and high-emphasis controls in the neutral theme.
- **UET Deep Blue** (#003a70): UET theme primary and its associated action emphasis.
- **VNU Burgundy** (#7b1e2b): VNU theme primary and its associated action emphasis.

### Neutral
- **Paper** (#ffffff): Page and card background in light mode.
- **Soft Mist** (#f5f5f5): Muted surfaces, secondary controls, and low-emphasis grouping.
- **Quiet Gray** (#6b6b6b): Supporting text and placeholders.
- **Hairline** (#e6e6e6): Section borders, dividers, and input outlines.
- **Soft Accent** (#f0f0f0): Hover and selected surfaces in the neutral theme.

### Named Rules
**The Rare Accent Rule.** Use color to identify university context or communicate state; do not flood an operational screen with accent color.

## Typography

**Display Font:** Geist (with `ui-sans-serif`, `system-ui`, `sans-serif` fallback)
**Body Font:** Geist (with `ui-sans-serif`, `system-ui`, `sans-serif` fallback)
**Label/Mono Font:** System monospace for identifiers and before/after policy values only.

**Character:** Geist keeps the interface modern, compact, and friendly without becoming editorial or institutional. Weight and spacing establish hierarchy; color remains secondary to readable structure.

### Hierarchy
- **Headline** (600, 24px, approximately 1.25 line-height): Page titles such as Feature control and Admin account.
- **Title** (600, 18px, tight tracking): Dialog and subsection headings.
- **Body** (400, 14px, 1.5 line-height): Descriptions, policy explanations, audit reasons, and operational copy.
- **Label** (600, 12px, 1.4 line-height): Metadata, field labels, provenance, and compact status text.
- **Data** (400, 12px, system monospace): Policy diff values and opaque identifiers where exact comparison matters.

### Named Rules
**The Clear Hierarchy Rule.** Prefer weight, spacing, and grouping before adding color or decoration to make a distinction.

## Layout

The admin shell uses a responsive two-region layout: a 240px desktop sidebar and a flexible content region, collapsing into a horizontally scrollable navigation row on smaller screens. Desktop content uses generous outer padding (`p-6` at large widths); mobile content uses compact `p-4` spacing. Policy controls are organized as flat bordered lists with divided rows, while summary counts sit in a four-column desktop grid and a two-column mobile grid.

The system favors one bordered section over nested containers. Content is width-bounded (`max-w-2xl` to `max-w-5xl` depending on task), keeps long descriptions readable, and reserves bottom space for the staged-change action bar. Primary controls and navigation links use practical 44px minimum touch targets where they affect important workflows.

## Elevation & Depth

Depth is primarily tonal and structural: background changes, one-pixel borders, dividers, and restrained grouping do most of the work. The interface does not rely on gradients, glass, glow, or ornamental shadows. A soft shadow is reserved for the fixed staged-change action bar, where it separates a persistent action surface from scrolling content.

### Shadow Vocabulary
- **Persistent action bar** (`shadow-lg`): Separates staged policy actions from the page content while changes are pending.
- **Default containers:** Prefer a border and tonal surface; do not add a shadow by default.

### Named Rules
**The Flat-by-Default Rule.** Surfaces are flat at rest; elevation appears only when a persistent or transient layer must be distinguished.

## Shapes

The form language uses modest rounded corners: `rounded-md` (6px) for controls, `rounded-lg` (8px) for sections and lists, and `rounded-xl` (12px) for shared card primitives. Borders are one-pixel and use the theme border token. Inputs and buttons are compact but maintain comfortable vertical targets through explicit `min-h-11` usage in key admin flows. Dividers are horizontal and quiet; colored side stripes are not part of the system.

## Components

### Buttons
- **Shape:** Modestly rounded (`rounded-md` / 6px), with compact horizontal padding and explicit 44px targets for primary workflow controls.
- **Primary:** Theme primary background with theme primary foreground; used for publish, sign-in, rollback, and other committed actions.
- **Secondary / Ghost / Tertiary:** Secondary and outline buttons use neutral surfaces and border tokens; ghost buttons gain the accent surface on hover.
- **Hover / Focus:** Slight tonal shift on hover, visible 2px ring using the ring token, and subtle press scale feedback.
- **Disabled:** Reduced opacity and no pointer interaction; never rely on color alone to explain the disabled state.

### Cards / Containers
- **Corner Style:** `rounded-lg` for admin sections; `rounded-xl` for the shared card primitive.
- **Background:** Paper/card token in light mode, theme-aware dark surface in dark mode.
- **Shadow Strategy:** Border-first; shadow only for the persistent staged-change action bar.
- **Border:** One-pixel `border-border` around lists, sections, dialogs, and cards.
- **Internal Padding:** Typically 16px for sections and 20px for card headers/content.

### Inputs / Fields
- **Style:** Full-width neutral background, one-pixel border, 6px radius, 12px horizontal padding, and 14px text.
- **Focus:** Visible ring using the theme ring token; focus must remain visible in light, dark, UET, and VNU themes.
- **Error / Disabled:** Destructive text/alert treatment for errors; disabled controls retain their label and visibly reduce interaction affordance.

### Navigation
- **Style:** A quiet sidebar on desktop and horizontal navigation on mobile, with icon-plus-label links, subtle rounded hit areas, and muted default text.
- **Active / Hover:** Accent surface and accent foreground; no animated or decorative indicator is required.
- **Mobile:** Navigation remains keyboard and touch usable, scrolls horizontally when necessary, and preserves practical target sizing.

### Policy Rows
- **Style:** Flat, divided rows with a strong capability/limit label, supporting description, provenance or ceiling metadata, and a right-aligned switch or numeric field.
- **Behavior:** Locked adapter capabilities remain visibly explained; staged changes collect in a persistent bottom action bar and require review plus a reason before publication.

## Do's and Don'ts

### Do:
- **Do** preserve theme tokens for neutral, UET, VNU, dark-mode, success, warning, and destructive states.
- **Do** use semantic controls, visible labels, keyboard operation, clear focus rings, and practical 44px targets.
- **Do** keep collections in one bordered section with loading, error, and empty states.
- **Do** make policy provenance, native ceilings, revision numbers, conflicts, and reasons explicit.
- **Do** keep body copy readable and use monospace only for exact identifiers or diffs.
- **Do** localize app-authored strings in both English and Vietnamese.

### Don't:
- **Don't** make the interface look like an institutional form dump; retain clear hierarchy and a recognizable Hyeboard identity.
- **Don't** use gradients, glassmorphism, glow effects, decorative sparklines, or ornamental dashboard chrome.
- **Don't** nest cards inside cards or turn every metric into a floating tile; prefer flat bordered sections and rows.
- **Don't** invent university capabilities, data, testimonials, or operational claims.
- **Don't** use color as the only signal for state, capability, error, or focus.
- **Don't** expose credentials, upstream tokens, or student PII in UI diagnostics, exports, or screenshots.
