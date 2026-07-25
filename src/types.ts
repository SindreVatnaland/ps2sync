// Shared unions/types across the app. Keep small — DB row types live in db/schema.ts.

export type Console = 'ps1' | 'ps2';

// Where a game lands on disk / how OPL loads it:
// 'dvd'  -> /data/DVD  (PS2 DVD image)
// 'cd'   -> /data/CD   (PS2 CD image)
// 'pops' -> /data/POPS (PS1 .VCD, launched by POPStarter)
export type Media = 'dvd' | 'cd' | 'pops';

export type JobKind = 'upload' | 'url';

// Job lifecycle. `duplicate`, `ready`, `failed` are terminal.
export type JobState =
  | 'pending'
  | 'downloading'
  | 'identifying'
  | 'converting'
  | 'placing'
  | 'duplicate'
  | 'ready'
  | 'failed';

// Result of inspecting an uploaded/downloaded image (serial from SYSTEM.CNF etc.).
export interface IdentifyResult {
  console: Console;
  serial: string; // disc serial, e.g. SLUS-20946 (PS2) or SCUS-94163 (PS1)
  title: string;
  media: Media;
}
