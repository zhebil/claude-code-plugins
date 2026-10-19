export const REPLY = 'Flow:\n\n```mermaid\nflowchart LR\n  A[kickoff] --> B[propose]\n```\n\nDone.'

export const WIDE = [
  '```mermaid',
  'flowchart LR',
  '  T["Drawn-body test (1h)"] --> D[Decide lying approach]',
  '  D --> DR[rig drawn] & K[клубочок] & LM[Lying moves]',
  '  R["Round-2 shapes: revisit or keep? (brand-2we.1)"] --> TK[DTCG tokens]',
  '  TK --> RS[TS/CSS for Remotion] & DM[DESIGN.md] & FG[UI kit in Figma]',
  '  UB[Pick base UI kit] --> FG',
  '  RS --> MK[Motion kit] & DK[Diagram kit] & IN[Intro in Remotion]',
  '  DM --> CV[Recreate CV]',
  '  FG --> WEB[UI kit web] --> SITE[zhebil.com + blog]',
  '  CS[Content strategy] --> BLOG[Start writing]',
  '  SITE --> BLOG',
  '```',
].join('\n')

export const SHAPES = [
  '```mermaid',
  'flowchart TD',
  '  A([Start]) --> B{Is it valid?}',
  '  B -->|yes| C[Process it]',
  '  B -->|no| D[(Store error)]',
  '  C -.-> E((Done))',
  '  D ==> E',
  '  E --> A',
  '  C --> C',
  '```',
].join('\n')
