/** Free text from the workspace on one line, with control and invisible characters gone: one of them can blank the pane. */
export const oneLine = (value: unknown) =>
  String(value ?? '')
    .replace(/\p{Cf}/gu, '')
    .replace(/[\s\p{Cc}]+/gu, ' ')
    .trim()
