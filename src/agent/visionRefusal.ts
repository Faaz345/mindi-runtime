/**
 * Vision-refusal detection.
 *
 * Some provider routes (notably free-tier aggregators) silently drop image
 * content parts, and small vision-language models sometimes ignore image
 * tokens entirely. In both cases the model replies with a TEXT-ONLY refusal
 * pattern: "I can't see the image", "I need the image file to proceed",
 * "unable to retrieve the image from the file path", ...
 *
 * When the runtime DID attach an image and the model answers like this, the
 * answer is untrustworthy — the runtime should retry via a dedicated vision
 * capability (a different model/route) instead of presenting the refusal as
 * an analysis.
 *
 * This module is pure: detection only, no I/O.
 */

/**
 * Patterns that strongly indicate the model did NOT process an attached
 * image. Matched case-insensitively against the model's reply. Only applied
 * when an image was actually attached to the request (caller's job), which
 * keeps false positives near zero.
 */
const REFUSAL_PATTERNS: RegExp[] = [
  // "unable/cannot/can't ... see/view/access/retrieve/process/read/open ... image/photo/picture/screenshot/file"
  /\b(?:unable|cannot|can't|can not|not able)\b[\s\S]{0,60}?\b(?:see|view|access|retrieve|process|read|open|analyze|analyse|interpret|display)\b[\s\S]{0,60}?\b(?:image|photo|picture|screenshot|pic\b|attachment)/i,
  // reversed order: "the image ... cannot be accessed/retrieved/displayed"
  /\b(?:image|photo|picture|screenshot|attachment)\b[\s\S]{0,60}?\b(?:cannot|can't|can not|could not|couldn't|not)\b[\s\S]{0,40}?\b(?:be\s+)?(?:accessed|retrieved|displayed|processed|viewed|opened|read|seen)\b/i,
  // "I need the image file to proceed" / "please provide/upload the image"
  /\b(?:need|require)\b[\s\S]{0,40}?\b(?:image|photo|picture|screenshot|file)\b[\s\S]{0,40}?\b(?:proceed|analyz|process|continue|assist)/i,
  /\bplease\b[\s\S]{0,30}?\b(?:provide|upload|attach|send|share)\b[\s\S]{0,30}?\b(?:image|photo|picture|screenshot|file)\b/i,
  // "no image was attached/provided/uploaded/received"
  /\bno\b[\s\S]{0,20}?\b(?:image|photo|picture|screenshot)\b[\s\S]{0,40}?\b(?:attached|provided|uploaded|received|found|included|visible)/i,
  /\b(?:image|photo|picture|screenshot)\b[\s\S]{0,30}?\b(?:not|wasn't|was not|isn't|is not)\b[\s\S]{0,30}?\b(?:attached|provided|uploaded|received|included|visible|available)/i,
  // "I don't see (an|any|the) image"
  /\b(?:don't|do not|didn't|did not)\b[\s\S]{0,20}?\b(?:see|receive|got|get|detect)\b[\s\S]{0,25}?\b(?:any|an|the|your)?\s*\b(?:image|photo|picture|screenshot|attachment)\b/i,
  // "I'm a text-based AI / text-only model"
  /\btext[- ]based\s+(?:ai|assistant|model|language model)\b/i,
  /\btext[- ]only\s+(?:ai|assistant|model|language model)\b/i,
  // "I don't have the ability to view/process images"
  /\b(?:don't|do not|lack)\b[\s\S]{0,30}?\babil\w+\b[\s\S]{0,30}?\b(?:view|see|process|interpret|analyze|analyse)\b[\s\S]{0,25}?\b(?:images?|photos?|pictures?|visual)/i,
  // Explicit path-based retrieval failure (observed in the wild)
  /\bunable to retrieve the image from\b/i,
];

/**
 * True when the reply looks like a "I can't see the image" refusal.
 * Only call this when an image was attached to the request — the patterns
 * assume an image SHOULD have been visible to the model.
 */
export function isVisionRefusal(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  return REFUSAL_PATTERNS.some((re) => re.test(t));
}
